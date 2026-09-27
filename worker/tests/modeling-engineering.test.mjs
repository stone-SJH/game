import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { defaultContract } from '../agent/modeling-contract.mjs';
import { validateSpecs, validateSchema } from '../agent/modeling-evaluation.mjs';
import { atomicJson, hashFile, hashValue, readJson } from '../agent/modeling-io.mjs';
import { createModelingPipeline } from '../agent/modeling-pipeline.mjs';
import { initializeProductionPlans } from '../agent/production-harness.mjs';
import { objectiveRequirements, validateModelingDraft, modelingReferences, engineeringSchema,
  resolveEngineering, validateEngineeringAcceptance } from '../agent/modeling-engineering.mjs';

const capsule = { radiusMeters: 0.42, halfHeightMeters: 0.96, axis: 'Z' };
const traversal = { version: 1, space: 'asset-local-meters', capsule, marginMeters: 0.01,
  paths: [{ id: 'entry-exit', startMeters: [0, -2, 0.98], endMeters: [0, 2, 0.98] }],
  ueQuery: { channel: 'Visibility', traceComplex: false } };
const objective = '建造可供玩家通行的房间。保留滑翔和解谜。核实参考资料并独立验收。';
const draft = { reason: 'The room needs engineering metrics before authoring.', assets: [{
  assetId: 'room-shell', description: 'A traversable room shell', prompt: 'A stone room',
  requirements: ['玩家通行路径不得被碰撞堵住。', 'Keep the stone trim.'], referenceImages: [],
  maxTriangles: 1000, requireRig: false, requireClosedMesh: false,
  contract: defaultContract({ assetClass: 'modular-kit', traversal: null,
    runtime: { engine: 'unreal', profile: 'fbx-static', collision: 'convex', lodTriangles: [500], sockets: [], animations: [], lightmapUV: false } }),
}] };
const requirements = objectiveRequirements(objective);
function planFor(input = draft, rows = requirements, refs = []) {
  return { reason: 'Define missing engineering choices without claiming source-game measurements.', playerCapsule: capsule,
    playerDecision: 'Choose a 0.42 m radius and 0.96 m half-height as project controller metrics.',
    assets: input.assets.map(asset => ({ assetId: asset.assetId, needsTraversal: true, contract: { ...structuredClone(asset.contract),
      dimensions: { meters: [4, 4, 3], toleranceMeters: 0.005 },
      pivot: { mode: 'base-center', meters: null, toleranceMeters: 0.005 }, traversal: structuredClone(traversal) },
      designDecisions: ['Project-sized room 4 x 4 x 3 m, origin at base center; capsule centers have floor clearance.'] })),
    requirements: rows.map(item => ({ id: item.id, owner: 'gameplay', implementation: item.description, verification: 'Run the packaged interaction and record evidence.' })),
    references: refs.map(item => ({ path: item.path, observations: 'Read the supplied reference.' })),
    sources: [], unresolvedFacts: ['Reference-game visual proportions require research.'],
  };
}
async function temp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engineering-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
function v2(t) {
  const prior = process.env.MODELING_HARNESS_V2_ENABLED;
  process.env.MODELING_HARNESS_V2_ENABLED = '1';
  t.after(() => { if (prior === undefined) delete process.env.MODELING_HARNESS_V2_ENABLED; else process.env.MODELING_HARNESS_V2_ENABLED = prior; });
}

test('incomplete natural-language draft can reach engineering but cannot reach authoring', () => {
  validateModelingDraft(draft);
  assert.throws(() => validateSpecs(draft), error => error.kind === 'CONTRACT_INCOMPLETE');
  const result = resolveEngineering(draft, planFor(), { requirements });
  validateSpecs(result);
  assert.deepEqual(result.assets[0].requirements, draft.assets[0].requirements);
  assert.deepEqual(result.assets[0].contract.runtime.lodTriangles, [500]);
  assert.deepEqual(result.assets[0].contract.traversal.capsule, capsule);
  assert.deepEqual(objectiveRequirements(objective).map(row => row.description), ['建造可供玩家通行的房间。', '保留滑翔和解谜。', '核实参考资料并独立验收。']);
});

test('engineering cannot drop requirements, assets, references or technical obligations', () => {
  const refs = [{ path: 'references/room.md' }];
  for (const mutate of [
    value => value.assets.pop(),
    value => value.requirements.pop(),
    value => { value.requirements[1].id = value.requirements[0].id; },
    value => value.references.pop(),
    value => { value.assets[0].contract.budgets.materials++; },
    value => { value.assets[0].contract.runtime.lodTriangles = []; },
    value => { value.assets[0].designDecisions = []; },
    value => { value.assets[0].contract.traversal = null; },
    value => { value.playerCapsule.radiusMeters = 0.5; },
    value => { value.assets[0].needsTraversal = false; },
  ]) {
    const value = structuredClone(planFor(draft, requirements, refs));
    mutate(value);
    assert.throws(() => resolveEngineering(draft, value, { requirements, references: refs }));
  }
});

test('supplied dimensions, pivot and paths remain immutable', () => {
  const frozen = resolveEngineering(draft, planFor(), { requirements });
  for (const mutate of [
    value => { value.assets[0].contract.dimensions.meters[0] += 1; },
    value => { value.assets[0].contract.pivot.mode = 'center'; },
    value => { value.assets[0].contract.traversal.paths[0].endMeters[1] += 1; },
  ]) {
    const value = planFor(frozen);
    mutate(value);
    assert.throws(() => resolveEngineering(frozen, value, { requirements }), /cannot change/);
  }
});

test('reference intake carries text and images and rejects changed or unsafe files', async t => {
  const project = await temp(t);
  await fs.mkdir(path.join(project, 'references'));
  await fs.writeFile(path.join(project, 'references/room.md'), 'Explicit entrance width: 2.4 meters.');
  await fs.writeFile(path.join(project, 'references/room.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ZeoAAAAASUVORK5CYII=', 'base64'));
  const files = await Promise.all(['room.md', 'room.png'].map(async name => ({ name, localPath: `references/${name}`, sha256: await hashFile(path.join(project, 'references', name)) })));
  const references = await modelingReferences({ referenceFiles: files }, project);
  assert.equal(references.images.length, 1);
  assert.match(references.entries[0].text, /2.4 meters/);
  assert.equal(references.files.length, 2);
  await fs.appendFile(path.join(project, 'references/room.md'), 'changed');
  await assert.rejects(modelingReferences({ referenceFiles: files }, project), /changed/);
  await assert.rejects(modelingReferences({ referenceFiles: [{ ...files[0], localPath: '../outside' }] }, project), /Invalid modeling/);
});

test('all requirements, measured controller metrics and unknown source facts require evidence', async t => {
  const project = await temp(t);
  await fs.mkdir(path.join(project, 'evidence'));
  await fs.writeFile(path.join(project, 'evidence/playtest.json'), '{"measured":true}');
  const proof = ['evidence/playtest.json'];
  const plan = planFor();
  const acceptance = { criteria: requirements.map(({ id }) => ({ id, status: 'PASS', evidence: proof })),
    playerMetrics: { units: 'meters', capsule, evidence: proof },
    referenceResolutions: [{ fact: plan.unresolvedFacts[0], evidence: proof }] };
  await validateEngineeringAcceptance(plan, acceptance, project);
  for (const mutate of [
    value => value.criteria.pop(),
    value => value.criteria.push(value.criteria[0]),
    value => { value.criteria[0].status = 'NOT_APPLICABLE'; },
    value => { value.criteria[0].evidence = []; },
    value => { value.criteria[0].evidence = ['evidence/missing.json']; },
    value => { value.criteria[0].evidence = ['../outside']; },
    value => { value.criteria[0].evidence = ['acceptance/acceptance-report.json']; },
    value => { value.playerMetrics.capsule.radiusMeters = 42; },
    value => { value.playerMetrics.units = 'centimeters'; },
    value => { value.referenceResolutions = []; },
  ]) {
    const value = structuredClone(acceptance); mutate(value);
    await assert.rejects(validateEngineeringAcceptance(plan, value, project));
  }
});

test('pipeline resolves the reported failure, freezes engineering and preserves it across resume', async t => {
  v2(t);
  const root = await temp(t), project = path.join(root, 'project'), output = path.join(root, 'run');
  await fs.mkdir(project); await fs.mkdir(output);
  const stop = new Error('Stop before production authoring.');
  const calls = [];
  const options = { project, output, job: { taskId: 'engineering', workspaceId: 'workspace', runId: 'run', objective },
    invocation: { command: process.execPath, args: [] }, signal: new AbortController().signal,
    probe: async () => { throw stop; }, evaluate: async ({ name }) => {
      calls.push(name); return name === 'modeling-plan' ? draft : planFor();
    } };
  await assert.rejects(createModelingPipeline(options).prepare(), error => error === stop);
  assert.deepEqual(calls, ['modeling-plan', 'modeling-engineering']);
  const saved = await readJson(path.join(project, 'plan/engineering-plan.json'));
  assert.deepEqual(saved.requirements.map(row => row.description), requirements.map(row => row.description));
  assert.equal(saved.assets[0].contract.traversal.paths.length, 1);
  await assert.rejects(createModelingPipeline({ ...options, job: { ...options.job, runId: 'resumed' } }).prepare(), error => error === stop);
  assert.equal(calls.length, 2, 'Resume must reuse frozen plans, not create new budgets.');
  saved.playerCapsule.radiusMeters += 1;
  await atomicJson(path.join(project, 'plan/engineering-plan.json'), saved);
  await assert.rejects(createModelingPipeline(options).prepare(), /Frozen engineering plan changed/);
});

test('code-only objectives retain requirement coverage without inventing model work', async t => {
  v2(t);
  const root = await temp(t), project = path.join(root, 'project'), output = path.join(root, 'run');
  await fs.mkdir(project); await fs.mkdir(output);
  const input = { reason: 'Only repair existing input code.', assets: [] };
  const plan = { ...planFor(input), playerCapsule: null, playerDecision: 'Existing metrics remain unchanged.' };
  validateSchema(plan, engineeringSchema(input, requirements, []));
  const pipeline = createModelingPipeline({ project, output, job: { taskId: 'code-only', workspaceId: 'workspace', runId: 'run', objective },
    invocation: { command: process.execPath, args: [] }, signal: new AbortController().signal,
    evaluate: async ({ name }) => name === 'modeling-plan' ? input : plan });
  const result = await pipeline.prepare();
  assert.deepEqual(result.assets, []);
  await pipeline.verify();
  assert.equal((await readJson(path.join(project, 'plan/engineering-plan.json'))).requirements.length, requirements.length);
});

test('uploaded reference text and image reach both model calls with immutable evidence', async t => {
  v2(t);
  const root = await temp(t), project = path.join(root, 'project'), output = path.join(root, 'run');
  await fs.mkdir(path.join(project, 'references'), { recursive: true }); await fs.mkdir(output);
  await fs.writeFile(path.join(project, 'references/layout.md'), 'Keep the entrance facing south.');
  await fs.writeFile(path.join(project, 'references/layout.png'), 'fixture-image');
  const referenceFiles = await Promise.all(['layout.md', 'layout.png'].map(async name => ({ name,
    localPath: `references/${name}`, sha256: await hashFile(path.join(project, 'references', name)) })));
  const input = { reason: 'Update existing layout using the reference.', assets: [] };
  const refs = referenceFiles.map(file => ({ path: file.localPath }));
  const calls = [];
  const pipeline = createModelingPipeline({ project, output,
    job: { taskId: 'references', workspaceId: 'workspace', runId: 'run', objective, referenceFiles },
    invocation: { command: process.execPath, args: [] }, signal: new AbortController().signal,
    evaluate: async ({ name, prompt, images }) => {
      calls.push(name);
      assert.match(prompt, /Keep the entrance facing south/);
      assert.equal(images[0], path.join(project, 'references/layout.png'));
      return name === 'modeling-plan' ? input : { ...planFor(input, requirements, refs), playerCapsule: null };
    } });
  await pipeline.prepare();
  assert.deepEqual(calls, ['modeling-plan', 'modeling-engineering']);
  const plan = await pipeline.engineeringPlan();
  assert.deepEqual(plan.referenceHashes, referenceFiles.map(file => ({ path: file.localPath, sha256: file.sha256 })));
});

test('resume preserves accepted stage artifacts and consumed attempts', async t => {
  const project = await temp(t), job = { taskId: 'task', runId: 'first', objective: 'Build a game.' };
  const context = { requiredOutputs: ['Game.exe'], qualityCriteria: [] };
  await initializeProductionPlans(project, job, context);
  const file = path.join(project, 'plan/stage-manifest.json'), saved = await readJson(file);
  saved.stages[0] = { ...saved.stages[0], status: 'ACCEPTED', attempts: 3, evidence: ['prior.json'] };
  await atomicJson(file, saved);
  await initializeProductionPlans(project, { ...job, runId: 'second' }, context);
  const resumed = await readJson(file);
  assert.equal(resumed.runId, 'second');
  assert.deepEqual(resumed.stages, saved.stages);
  resumed.stages.pop(); await atomicJson(file, resumed);
  const before = hashValue(await readJson(file));
  await assert.rejects(initializeProductionPlans(project, job, context), /invalid production state/);
  assert.equal(hashValue(await readJson(file)), before);
});
