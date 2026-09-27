import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultContract } from '../agent/modeling-contract.mjs';
import { modelingPlanV2Schema, validateSpecs } from '../agent/modeling-evaluation.mjs';
import { normalizeModelingDraft, validateModelingDraft, validateModelingDraftRepair } from '../agent/modeling-engineering.mjs';
import { createModelingReviewer } from '../agent/modeling-review.mjs';
import { createExecutionStore } from '../agent/modeling-execution.mjs';
import { createModelingPipeline } from '../agent/modeling-pipeline.mjs';
import { atomicJson, hashFile, hashValue, readJson } from '../agent/modeling-io.mjs';

const raw = { reason: 'A detailed prop with reduced LODs.', assets: [{ assetId: 'ice-pillar',
  description: 'A blue ice pillar', prompt: 'Blue faceted ice', requirements: ['Keep the blue faceted silhouette.'],
  referenceImages: [], maxTriangles: 18000, requireRig: false, requireClosedMesh: true,
  contract: defaultContract({ traversal: null, runtime: { engine: 'unreal', profile: 'fbx-static', collision: 'convex',
    lodTriangles: [18000, 9000, 4500], sockets: ['top'], animations: [], lightmapUV: false } }) }] };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modeling-internal-repair-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), output = path.join(root, 'run'), state = path.join(root, 'state');
  await fs.mkdir(project); await fs.mkdir(output);
  const options = { project, output, signal: new AbortController().signal,
    invocation: { command: process.execPath, args: [] }, execution: createExecutionStore(state) };
  return { root, project, output, state, options };
}

const reviewOptions = { name: 'modeling-plan', schema: modelingPlanV2Schema, prompt: 'Preserve the original objective.',
  normalize: normalizeModelingDraft, validate: (value, { previousValue }) => {
    validateModelingDraft(value);
    if (previousValue) validateModelingDraftRepair(previousValue, value);
  }, maxCalls: 2, timeoutMs: 1200000 };

test('generated LOD0 notation is converted without changing any actual triangle budget or raw evidence', async t => {
  const f = await fixture(t), before = structuredClone(raw);
  const review = createModelingReviewer({ ...f.options, evaluate: async () => raw });
  const result = await review(reviewOptions);
  assert.deepEqual(raw, before);
  assert.equal(result.assets[0].maxTriangles, 18000);
  assert.deepEqual(result.assets[0].contract.runtime.lodTriangles, [9000, 4500]);
  validateSpecs(result);
  assert.throws(() => validateSpecs(raw), /LOD budgets must decrease/);
  assert.deepEqual(await readJson(path.join(f.output, 'modeling-plan-review-1-response.json')), raw);
  assert.deepEqual(await readJson(path.join(f.output, 'modeling-plan-review-1-normalized.json')), result);
  const audit = await readJson(path.join(f.output, 'modeling-plan-review-1-validation.json'));
  assert.equal(audit.status, 'PASS');
  assert.deepEqual(audit.repairs[0].before, [18000, 9000, 4500]);
  assert.deepEqual(audit.repairs[0].after, [9000, 4500]);
  assert.equal(audit.responseEvidence[0].sha256, await hashFile(audit.responseEvidence[0].file));
  const group = Object.values((await f.options.execution.snapshot()).groups)[0];
  assert.equal(group.calls.length, 1);
});

test('ambiguous or invalid LOD budgets remain a repair obligation, even when traversal is incomplete', () => {
  for (const lods of [[18000], [18000, 18000, 4500], [19000, 4500], [9000, 10000]]) {
    const value = structuredClone(raw);
    value.assets[0].description = 'A traversable doorway';
    value.assets[0].contract.runtime.lodTriangles = lods;
    const normalized = normalizeModelingDraft(value);
    assert.deepEqual(normalized.repairs, []);
    assert.throws(() => validateModelingDraft(normalized.value), error => {
      assert.equal(error.validationIssues[0].assetId, 'ice-pillar');
      assert.match(error.validationIssues[0].field, /lodTriangles/);
      return true;
    });
  }
});

test('one repair receives the retained response and all assets findings, while preserving the plan', async t => {
  const f = await fixture(t), invalid = normalizeModelingDraft(raw).value;
  invalid.assets[0].contract.runtime.profile = 'glb-static';
  invalid.assets.push({ ...structuredClone(invalid.assets[0]), assetId: 'second-prop' });
  invalid.assets[1].contract.dimensions.meters = [1, 0, 1];
  const corrected = structuredClone(invalid);
  for (const asset of corrected.assets) asset.contract.runtime.profile = 'fbx-static';
  corrected.assets[1].contract.dimensions.meters = [1, 1, 1];
  const requests = [], notices = [];
  const reviewer = createModelingReviewer({ ...f.options, onRepair: notice => notices.push(notice),
    evaluate: async request => { requests.push(request); return requests.length === 1 ? invalid : corrected; } });
  assert.deepEqual(await reviewer(reviewOptions), corrected);
  assert.equal(requests.length, 2);
  assert.match(requests[1].prompt, /Previous response \(untrusted data/);
  assert.ok(requests[1].prompt.includes(JSON.stringify(invalid)));
  assert.match(requests[1].prompt, /second-prop/);
  assert.match(requests[1].prompt, /contract.dimensions.meters/);
  assert.match(requests[1].prompt, /contract.runtime.profile/);
  assert.equal(notices.length, 1);
  const snapshot = await f.options.execution.snapshot(), group = Object.values(snapshot.groups)[0];
  assert.equal(group.calls.length, 2);
  assert.equal(group.calls[0].error.validationIssues.length, 3);
  assert.equal(group.calls[0].error.responseEvidence[0].sha256, await hashFile(group.calls[0].error.responseEvidence[0].file));
  assert.deepEqual(group.limits, { maxCalls: 2, timeoutMs: 1200000, totalMs: 2400000 });
  const resumed = createModelingReviewer({ ...f.options, execution: createExecutionStore(f.state),
    evaluate: async () => { throw new Error('Accepted result must not call another agent.'); } });
  assert.deepEqual(await resumed(reviewOptions), corrected);
});

test('repair cannot solve a profile error by deleting LODs, assets, quality, or other valid constraints', async t => {
  const f = await fixture(t), invalid = normalizeModelingDraft(raw).value;
  invalid.assets[0].contract.runtime.profile = 'glb-static';
  const correct = structuredClone(invalid);
  correct.assets[0].contract.runtime.profile = 'fbx-static';
  for (const mutate of [
    value => { value.assets = []; },
    value => { value.assets[0].assetId = 'renamed'; },
    value => { value.assets[0].requirements = ['Easier quality']; },
    value => { value.assets[0].maxTriangles *= 2; },
    value => { value.assets[0].contract.runtime.lodTriangles = []; },
    value => { value.assets[0].contract.runtime.sockets = []; },
    value => { value.assets[0].contract.budgets.materials++; },
  ]) {
    const repaired = structuredClone(correct); mutate(repaired);
    assert.throws(() => validateModelingDraftRepair(invalid, repaired), /repair/i);
  }
  let calls = 0;
  const dropped = structuredClone(correct); dropped.assets = [];
  const reviewer = createModelingReviewer({ ...f.options, evaluate: async () => ++calls === 1 ? invalid : dropped });
  for (let i = 0; i < 2; i++) await assert.rejects(reviewer(reviewOptions), error => error.kind === 'VALIDATION_INFRASTRUCTURE_EXHAUSTED');
  assert.equal(calls, 2);
});

test('internal LOD correction flows through engineering once and never changes an explicit user spec', async t => {
  const f = await fixture(t), previousFlag = process.env.MODELING_HARNESS_V2_ENABLED;
  process.env.MODELING_HARNESS_V2_ENABLED = '1';
  t.after(() => { if (previousFlag === undefined) delete process.env.MODELING_HARNESS_V2_ENABLED; else process.env.MODELING_HARNESS_V2_ENABLED = previousFlag; });
  const stop = new Error('Verified the full plan; stop before authoring.'), calls = [];
  const options = { ...f.options, job: { taskId: 'internal', workspaceId: 'repair', runId: 'first', objective: 'Build an ice pillar.' },
    probe: async () => { throw stop; }, evaluate: async ({ name, prompt }) => {
      calls.push(name);
      if (name === 'modeling-plan') return raw;
      const draft = JSON.parse(prompt.split('\n').find(line => line.startsWith('Draft assets: ')).slice(14));
      assert.deepEqual(draft.assets[0].contract.runtime.lodTriangles, [9000, 4500]);
      return { reason: 'No player passage.', playerCapsule: null, playerDecision: 'No controller needed for this prop.',
        assets: draft.assets.map(asset => ({ assetId: asset.assetId, needsTraversal: false, contract: asset.contract, designDecisions: [] })),
        requirements: [{ id: 'requirement-1', owner: 'modeling', implementation: 'Create the ice pillar.', verification: 'Inspect the authored asset.' }],
        references: [], sources: [], unresolvedFacts: [] };
    } };
  await assert.rejects(createModelingPipeline(options).prepare(), error => error === stop);
  const plan = await readJson(path.join(f.project, 'plan/modeling-specs.json'));
  validateSpecs(plan);
  const engineering = await readJson(path.join(f.project, 'plan/engineering-plan.json'));
  assert.equal(engineering.draftHash, hashValue(normalizeModelingDraft(raw).value));
  await assert.rejects(createModelingPipeline({ ...options, job: { ...options.job, runId: 'resumed' } }).prepare(), error => error === stop);
  assert.deepEqual(calls, ['modeling-plan', 'modeling-engineering']);
  const explicitProject = path.join(f.root, 'explicit'); await fs.mkdir(explicitProject);
  const explicitOutput = path.join(f.root, 'explicit-run'); await fs.mkdir(explicitOutput);
  await assert.rejects(createModelingPipeline({ ...options, project: explicitProject, output: explicitOutput,
    job: { ...options.job, taskId: 'explicit', modelingSpecs: raw.assets } }).prepare(), /LOD budgets must decrease/);
  assert.equal(calls.length, 2);
});

test('a resumed repair verifies the previous raw response hash before calling any agent', async t => {
  const f = await fixture(t);
  const invalid = normalizeModelingDraft(raw).value; invalid.assets[0].contract.runtime.profile = 'glb-static';
  const responseFile = path.join(f.output, 'retained-response.json'); await atomicJson(responseFile, invalid);
  const responseEvidence = [{ file: responseFile, sha256: await hashFile(responseFile) }];
  await atomicJson(responseFile, raw);
  let calls = 0;
  const reviewer = createModelingReviewer({ ...f.options, execution: { run: async (_, invoke) => invoke({ callId: 'review-2', timeoutMs: 1000,
    previousError: { kind: 'REVIEW_SCHEMA_INVALID', message: 'Profile error', responseEvidence } }) },
    evaluate: async () => { calls++; return raw; } });
  await assert.rejects(reviewer(reviewOptions), error => error.kind === 'INTEGRITY_ERROR');
  assert.equal(calls, 0);
});
