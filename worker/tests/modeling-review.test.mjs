import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createModelingPipeline } from '../agent/modeling-pipeline.mjs';
import { validateUnrealModels } from '../agent/modeling-unreal.mjs';
import { defaultContract } from '../agent/modeling-contract.mjs';
import { atomicJson, hashFile, hashValue, readJson } from '../agent/modeling-io.mjs';
import { readModelingState, writeModelingState } from '../agent/modeling-state.mjs';

const spec = { assetId: 'fixture', description: 'A red fixture', prompt: 'A red fixture', requirements: ['Red body'],
  referenceImages: [], maxTriangles: 100, requireRig: false, requireClosedMesh: false };
const validReview = status => ({ criteria: [{ criterion: 'Red body', status, evidence: 'The body is visible in front.png' }], smallEditsOnly: true, repairInstructions: status === 'GAP' ? 'Correct body color' : '' });
const ok = { exitCode: 0, stopConfirmed: true };
async function fixture(t, responses, reuse = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modeling-review-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), output = path.join(root, 'run');
  await fs.mkdir(project); await fs.mkdir(output);
  const counts = { author: 0, technical: 0, review: 0 };
  if (reuse) {
    await fs.writeFile(path.join(project, 'existing.blend'), 'original');
    await fs.writeFile(path.join(project, 'existing.png'), 'image');
    await atomicJson(path.join(project, 'provenance/modeling-catalog.json'), { assets: [{ path: 'existing.blend', source: 'fixture', license: 'task owned', previewImages: ['existing.png'] }] });
  }
  const options = { project, output, job: { taskId: 'task', workspaceId: 'workspace', runId: 'run', objective: spec.description, modelingSpecs: [spec] },
    signal: new AbortController().signal, invocation: { command: process.execPath, args: [] },
    probe: async () => ({ blenderMcpAvailable: true }), provider: { availability: async () => ({ enabled: false }) },
    build: async ({ directory }) => {
      counts.author++;
      await fs.writeFile(path.join(project, directory, 'source.blend'), 'model source');
      await fs.writeFile(path.join(project, directory, 'model.glb'), 'export');
      await atomicJson(path.join(project, directory, 'build-report.json'), { smallEditsOnly: true });
    },
    step: async (name, command, args) => {
      assert.ok(name.startsWith('modeling-geometry-'));
      counts.technical++;
      const file = args[args.indexOf('--report') + 1];
      for (const view of ['front', 'side', 'back', 'perspective']) await fs.writeFile(path.join(path.dirname(file), `${view}.png`), 'frozen image');
      await atomicJson(file, { assetId: spec.assetId, passed: true }); return ok;
    },
    evaluate: async ({ name, prompt }) => {
      if (name === 'modeling-evaluation') {
        const candidates = JSON.parse(prompt.split('\n').find(line => line.startsWith('Candidates: ')).slice(12));
        const predictions = [{ criterion: 'Red body', achievable: true, evidence: 'Local material edit' }];
        return { complexity: 'low', precision: 'Game prop', qualityTarget: 'Red body', capabilityCoverage: 'Blender available', unknowns: [], confidence: .9,
          candidates: candidates.map(c => ({ assetId: c.assetId, similarity: 1, canMeetQuality: true, editPlan: ['Recolor'], qualityByCriterion: predictions, reason: 'Same body' })),
          direct: { canMeetQuality: true, estimatedMinutes: 10, plan: ['Build'], qualityByCriterion: predictions },
          thirdParty: { assessed: false, preferred: false, smallEditsOnly: false, editMinutes: 0, editPlan: [], qualityByCriterion: [], reason: 'disabled' }, rationale: 'Use Blender' };
      }
      const result = responses[Math.min(counts.review++, responses.length - 1)];
      if (result instanceof Error) throw result;
      return result;
    } };
  return { root, options, counts };
}

test('two invalid visual responses retry the same evidence without rebuilding or rejecting reuse', async t => {
  const f = await fixture(t, [{ wrong: 'PASS' }, { criteria: [] }, validReview('PASS')], true);
  const result = await createModelingPipeline(f.options).prepare();
  assert.equal(result.assets[0].route, 'reuse_blender');
  assert.deepEqual(f.counts, { author: 1, technical: 1, review: 3 });
  assert.equal(result.assets[0].failures.some(f => f.reason === 'reuse_quality_gap'), false);
  assert.equal(await fs.readFile(path.join(f.options.project, 'existing.blend'), 'utf8'), 'original');
});

test('review service failure does not consume an author attempt', async t => {
  const error = Object.assign(new Error('service failed'), { result: { exitCode: 1, stopConfirmed: true } });
  const f = await fixture(t, [error, validReview('PASS')]);
  await createModelingPipeline(f.options).prepare();
  assert.deepEqual(f.counts, { author: 1, technical: 1, review: 2 });
});

test('technical process retries preserve the authored model and reject no source', async t => {
  const f = await fixture(t, [validReview('PASS')]);
  const step = f.options.step; let calls = 0;
  f.options.step = async (...args) => {
    if (++calls === 1) throw Object.assign(new Error('checker process unavailable'), { result: { exitCode: 1, stopConfirmed: true } });
    return step(...args);
  };
  await createModelingPipeline(f.options).prepare();
  assert.equal(calls, 2); assert.equal(f.counts.author, 1); assert.equal(f.counts.review, 1);
});

test('review exhaustion preserves technical evidence and cannot restart its budget on resume', async t => {
  const f = await fixture(t, [{ verdict: 'PASS' }], true);
  for (let i = 0; i < 2; i++) {
    const result = await createModelingPipeline(f.options).prepare();
    assert.equal(result.assets[0].status, 'DCC_PROVISIONAL');
    assert.equal(result.assets[0].quality.accepted, false);
  }
  assert.deepEqual(f.counts, { author: 1, technical: 1, review: 4 });
  const states = (await fs.readdir(path.join(f.root, 'modeling-state'))).filter(n => n !== 'tasks');
  const state = await readModelingState(path.join(f.root, 'modeling-state', states[0], 'state.json'));
  assert.equal(state.pending, null);
  assert.deepEqual(state.rejectedSources, []);
  assert.equal(state.attempts.reuse_blender, 1);
});

test('a valid visual GAP ends its review and starts a real repair', async t => {
  const f = await fixture(t, [validReview('GAP'), validReview('PASS')]);
  const result = await createModelingPipeline(f.options).prepare();
  assert.deepEqual(f.counts, { author: 2, technical: 2, review: 2 });
  assert.equal(result.assets[0].failures[0].kind, 'VISUAL_GAP');
});

test('a visually deficient asset hands off its best usable result, other assets complete, and only a completed new iteration repairs it', async t => {
  const f = await fixture(t, [validReview('GAP')]); let improve = false;
  f.options.job.modelingSpecs = [spec, { ...spec, assetId: 'other' }];
  f.options.check = async ({ spec: asset, previousAttemptDirectory }) => {
    if (improve && asset.assetId === 'fixture') assert.ok(previousAttemptDirectory);
    const passed = asset.assetId === 'other' || improve;
    return { passed, kind: passed ? null : 'VISUAL_GAP', smallEditsOnly: true, feedback: validReview(passed ? 'PASS' : 'GAP') };
  };
  const first = await createModelingPipeline(f.options).prepare({ iteration: 1 });
  assert.deepEqual(first.assets.map(asset => asset.status), ['DCC_PROVISIONAL', 'DCC_READY']);
  assert.equal(f.counts.author, 4);
  assert.equal(first.assets[0].quality.accepted, false);
  await createModelingPipeline(f.options).prepare({ iteration: 1 });
  assert.equal(f.counts.author, 4);
  improve = true;
  const next = await createModelingPipeline(f.options).prepare({ iteration: 2 });
  assert.deepEqual(next.assets.map(asset => asset.status), ['DCC_READY', 'DCC_READY']);
  assert.equal(f.counts.author, 5);
  assert.equal(next.assets[1].reused, true);
});

test('all author executions failing do not mislabel a reuse quality gap', async t => {
  const f = await fixture(t, [validReview('PASS')], true);
  f.options.build = async () => { f.counts.author++; throw new Error('author service unavailable'); };
  await assert.rejects(createModelingPipeline(f.options).prepare(), error => error.kind === 'SERVICE_TRANSIENT');
  assert.deepEqual(f.counts, { author: 1, technical: 0, review: 0 });
});

test('exhausted technical checks retain an asset gap, finish other assets and retry only next round', async t => {
  const f = await fixture(t, [validReview('PASS')]);
  f.options.job.modelingSpecs.push({ ...spec, assetId: 'other' });
  let recovered = false;
  const original = f.options.step;
  f.options.step = async (...args) => {
    const current = await readJson(args[2][args[2].indexOf('--spec') + 1]);
    if (current.assetId === 'fixture' && !recovered) {
      f.counts.technical++;
      throw Object.assign(new Error('technical checker unavailable'), { result: { exitCode: 1, stopConfirmed: true } });
    }
    const result = await original(...args);
    const file = args[2][args[2].indexOf('--report') + 1];
    await atomicJson(file, { assetId: current.assetId, passed: true });
    return result;
  };
  const first = await createModelingPipeline(f.options).prepare();
  assert.deepEqual(first.assets.map(asset => asset.status), ['NO_USABLE_ARTIFACT', 'DCC_READY']);
  assert.deepEqual(f.counts, { author: 2, technical: 4, review: 1 });
  assert.match(first.assets[0].quality.gaps[0].reason, /exhausted/);
  await createModelingPipeline(f.options).prepare();
  assert.deepEqual(f.counts, { author: 2, technical: 4, review: 1 });
  recovered = true;
  const next = await createModelingPipeline(f.options).prepare({ iteration: 2 });
  assert.deepEqual(next.assets.map(asset => asset.status), ['DCC_READY', 'DCC_READY']);
  assert.equal(f.counts.author, 3);
});

test('malformed build report is retained as a gap instead of failing the task', async t => {
  const f = await fixture(t, [validReview('PASS')]);
  const original = f.options.build;
  f.options.build = async context => { await original(context); await fs.writeFile(path.join(f.options.project, context.directory, 'build-report.json'), '{broken'); };
  const first = await createModelingPipeline(f.options).prepare();
  assert.equal(first.assets[0].status, 'NO_USABLE_ARTIFACT');
  assert.match(first.assets[0].quality.gaps[0].reason, /JSON/);
  f.options.build = original;
  assert.equal((await createModelingPipeline(f.options).prepare({ iteration: 2 })).assets[0].status, 'DCC_READY');
});

test('capability outage consumes durable retries and permits a later round to recover', async t => {
  const f = await fixture(t, [validReview('PASS')]); let probes = 0, available = false;
  f.options.probe = async () => { probes++; return { blenderMcpAvailable: available }; };
  for (let n = 0; n < 2; n++) assert.equal((await createModelingPipeline(f.options).prepare()).assets[0].status, 'NO_USABLE_ARTIFACT');
  assert.equal(probes, 2); assert.equal(f.counts.author, 0);
  available = true;
  assert.equal((await createModelingPipeline(f.options).prepare({ iteration: 2 })).assets[0].status, 'DCC_READY');
  assert.equal(probes, 3);
});

test('internal revision repair retains the original plan and retries unresolved additions next round', async t => {
  const f = await fixture(t, [validReview('PASS')]);
  const pipeline = createModelingPipeline(f.options);
  await pipeline.prepare();
  const raw = { reason: 'Additional asset', assets: [spec, { ...spec, assetId: 'addition', maxTriangles: null }] };
  await atomicJson(path.join(f.options.project, 'plan/modeling-request.json'), raw);
  await pipeline.deferRequest();
  let repaired = false, revisionCalls = 0;
  const evaluate = f.options.evaluate;
  f.options.evaluate = async context => {
    if (context.name !== 'modeling-revision') return evaluate(context);
    revisionCalls++;
    return { reason: raw.reason, assets: repaired ? [spec, { ...spec, assetId: 'addition' }] : [spec] };
  };
  const gap = await createModelingPipeline(f.options).prepare({ iteration: 2 });
  assert.ok(gap.issues.some(issue => issue.stage === 'modeling-revision'));
  assert.equal(gap.assets.length, 1); assert.equal(revisionCalls, 2);
  await createModelingPipeline(f.options).prepare({ iteration: 2 }); assert.equal(revisionCalls, 2);
  repaired = true;
  f.options.check = async () => ({ passed: true, smallEditsOnly: true, feedback: validReview('PASS') });
  const next = await createModelingPipeline(f.options).prepare({ iteration: 3 });
  assert.deepEqual(next.assets.map(asset => asset.assetId), ['fixture', 'addition']);
  assert.equal(revisionCalls, 3);
});

async function engineFixture(t, ids = ['fixture']) {
  const f = await fixture(t, [validReview('PASS')]), { project, output, signal, invocation } = f.options;
  const assetSpec = { ...spec, contract: defaultContract({ runtime: { engine: 'unreal', profile: 'glb-static', collision: 'none', lodTriangles: [], sockets: [], animations: [], lightmapUV: false } }) };
  await fs.mkdir(path.join(project, 'Content'), { recursive: true });
  const projectFile = path.join(project, 'Test.uproject'); await fs.writeFile(projectFile, '{}');
  await fs.mkdir(path.join(project, 'model'));
  await fs.writeFile(path.join(project, 'model/model.glb'), 'export');
  await atomicJson(path.join(project, 'model/geometry-report.json'), { export: { dimensions: [1,1,1] }, source: { gates: [] } });
  await atomicJson(path.join(project, 'plan/modeling-engine-imports.json'), { protocol: 2, assets: ids.map(assetId => ({ assetId, packagePath: `/Game/${assetId}.${assetId}`, mapPath: '/Game/Test' })) });
  const asset = { assetId: 'fixture', requirementsHash: 'requirements', spec: assetSpec, contract: assetSpec.contract,
    files: [{ path: 'model/model.glb', sha256: await hashFile(path.join(project, 'model/model.glb')) }, { path: 'model/geometry-report.json' }] };
  const counts = { technical: 0, reviews: 0 };
  const pass = { ...validReview('PASS'), criteria: validReview('PASS').criteria.map(c => ({ ...c, views: ['image-1'] })) };
  const options = { project, output, signal, invocation, projectFile, unreal: process.execPath, attempt: 1,
    summary: { assets: ids.map(assetId => ({ ...asset, assetId, spec: { ...assetSpec, assetId } })) },
    evaluate: async () => ++counts.reviews < 3 ? { wrong: 'PASS' } : pass,
    step: async (name, command, args) => {
      counts.technical++;
      const wrapper = args.find(a => a.startsWith('-script=')).slice(8), directory = path.dirname(wrapper);
      const image = path.join(directory, 'front.png'); await fs.writeFile(image, 'frozen screenshot');
      await atomicJson(path.join(directory, 'report.json'), { requestHash: await hashFile(path.join(directory, 'request.json')), passed: true,
        assets: ids.map(assetId => ({ assetId, requirementsHash: 'requirements', passed: true, views: [] })) });
      const report = await readJson(path.join(directory, 'report.json'));
      for (const row of report.assets) row.views = [{ file: image, sha256: await hashFile(image) }];
      await atomicJson(path.join(directory, 'report.json'), report);
      return ok;
    } };
  return { options, counts, pass };
}

test('Unreal visual retries and resumed acceptance reuse the original capture and import', async t => {
  const { options, counts } = await engineFixture(t);
  assert.equal((await validateUnrealModels(options)).status, 'ENGINE_READY');
  assert.equal((await validateUnrealModels({ ...options, attempt: 2 })).status, 'ENGINE_READY');
  assert.equal((await validateUnrealModels({ ...options, attempt: 1, job: { revisionId: 'new-revision', runId: 'new-run' } })).status, 'ENGINE_READY');
  assert.equal(counts.technical, 1); assert.equal(counts.reviews, 3);
});

test('confirmed service failure settles the author reservation without resetting its count', async t => {
  const f = await fixture(t, [validReview('PASS')]);
  f.options.job.revisionId = 'first-revision';
  const build = f.options.build;
  f.options.build = async () => { f.counts.author++; throw Object.assign(new Error('HTTP 503 upstream'), { stopConfirmed: true }); };
  await assert.rejects(createModelingPipeline(f.options).prepare(), error => error.kind === 'SERVICE_TRANSIENT');
  const directories = await fs.readdir(path.join(f.root, 'modeling-state'));
  const stateDirectory = directories.find(name => /^[a-f0-9]{20}$/.test(name));
  const stateFile = path.join(f.root, 'modeling-state', stateDirectory, 'state.json');
  const failed = await readJson(stateFile);
  assert.equal(failed.pending, null); assert.equal(failed.attempts.blender_direct, 1);
  f.options.build = build; f.options.job.revisionId = 'next-revision';
  assert.equal((await createModelingPipeline(f.options).prepare()).assets[0].status, 'DCC_READY');
  assert.equal((await readJson(stateFile)).attempts.blender_direct, 2);
});

test('a scoped revision repair improves an accepted source once and never carries into an unrelated continuation', async t => {
  const f = await fixture(t, [validReview('PASS')]); f.options.job.revisionId = 'revision-a';
  await createModelingPipeline(f.options).prepare();
  await atomicJson(path.join(f.options.project, 'plan/modeling-repair-request.json'), { revisionId: 'revision-a', assetIds: ['fixture'], reason: 'Refine edge detail' });
  await createModelingPipeline(f.options).prepare({ iteration: 2 });
  assert.equal(f.counts.author, 2);
  await createModelingPipeline(f.options).prepare({ iteration: 3 });
  f.options.job.revisionId = 'revision-b';
  await createModelingPipeline(f.options).prepare();
  assert.equal(f.counts.author, 2);
});

for (const previousFormat of [false, true]) test('whole iterations preserve the revision author budget (' + (previousFormat ? 'pre-merge state' : 'current state') + ')', async t => {
  const f = await fixture(t, [validReview('PASS')]); f.options.job.revisionId = 'revision-budget';
  f.options.build = async () => { f.counts.author++; throw new Error('Invalid Blender output'); };
  await createModelingPipeline(f.options).prepare();
  assert.equal(f.counts.author, 3);
  const directory = (await fs.readdir(path.join(f.root, 'modeling-state'))).find(name => /^[a-f0-9]{20}$/.test(name));
  const file = path.join(f.root, 'modeling-state', directory, 'state.json');
  if (previousFormat) {
    const state = await readModelingState(file);
    state.rounds = { 'revision-budget': state.rounds[state.productionIteration] };
    delete state.rounds['revision-budget'].iteration; delete state.revisionBudgets;
    await writeModelingState(file, state);
  }
  f.options.job.runId = 'recovered-run';
  await createModelingPipeline(f.options).prepare({ iteration: 2 });
  assert.equal(f.counts.author, 3);
  assert.equal((await readModelingState(file)).revisionBudgets['revision-budget'].attempts.blender_direct, 3);
  f.options.job.revisionId = 'answer-with-inherited-budget';
  f.options.job.payload = { budgetRevisionId: 'revision-budget', inputAnswer: { protocol: 1 } };
  await createModelingPipeline(f.options).prepare();
  assert.equal(f.counts.author, 3, 'an answer revision must not refund consumed author calls');
  delete f.options.job.payload;
  f.options.job.revisionId = 'explicit-new-revision';
  await createModelingPipeline(f.options).prepare();
  assert.equal(f.counts.author, 6);
});

test('Unreal review outages keep their service identity and reuse successful technical evidence', async t => {
  const { options, counts, pass } = await engineFixture(t, ['fixture', 'second']);
  let recovered = false, failedCalls = 0;
  options.allowProvisional = true;
  options.evaluate = async ({ prompt }) => {
    counts.reviews++;
    const asset = JSON.parse(prompt.split('\n').find(line => line.startsWith('Specification: ')).slice(15));
    if (asset.assetId === 'fixture' && !recovered) { failedCalls++; throw new Error('review service unavailable'); }
    return pass;
  };
  await assert.rejects(validateUnrealModels(options), error => error.kind === 'SERVICE_TRANSIENT');
  assert.equal(failedCalls, 1);
  await assert.rejects(validateUnrealModels({ ...options, attempt: 2 }), error => error.kind === 'SERVICE_TRANSIENT');
  assert.equal(counts.reviews, 1); assert.equal(counts.technical, 1);
  recovered = true;
  assert.equal((await validateUnrealModels({ ...options, iteration: 2, attempt: 3 })).status, 'ENGINE_READY');
  assert.equal(counts.reviews, 3); assert.equal(counts.technical, 1);
});

test('Unreal technical service exhaustion cannot permanently poison a later production round', async t => {
  const { options, counts, pass } = await engineFixture(t);
  const step = options.step; let offline = true, failedCalls = 0;
  options.evaluate = async () => pass;
  options.step = async (...args) => { if (offline) { failedCalls++; throw new Error('checker offline'); } return step(...args); };
  await assert.rejects(validateUnrealModels(options), error => error.kind === 'VALIDATION_INFRASTRUCTURE_EXHAUSTED');
  await assert.rejects(validateUnrealModels({ ...options, attempt: 2 }), error => error.kind === 'VALIDATION_INFRASTRUCTURE_EXHAUSTED');
  assert.equal(failedCalls, 3);
  offline = false;
  assert.equal((await validateUnrealModels({ ...options, iteration: 2, attempt: 3 })).status, 'ENGINE_READY');
  assert.equal(counts.technical, 1);
});

test('Unreal failed technical asset does not suppress visual checks for independent assets', async t => {
  const { options, pass } = await engineFixture(t, ['fixture', 'second']);
  const step = options.step; let reviews = 0;
  options.allowProvisional = true;
  options.evaluate = async () => { reviews++; return pass; };
  options.step = async (...args) => {
    const result = await step(...args), directory = path.dirname(args[2].find(arg => arg.startsWith('-script=')).slice(8));
    const file = path.join(directory, 'report.json'), report = await readJson(file);
    report.passed = false; report.assets[0].passed = false; await atomicJson(file, report); return result;
  };
  const result = await validateUnrealModels(options);
  assert.equal(result.score, 50); assert.equal(reviews, 1);
  assert.equal(result.assets[0].quality.gaps[0].kind, 'TECHNICAL_GAP');
  assert.equal(result.assets[1].quality.accepted, true);
});

test('accepted model mutation remains fenced on a fresh pipeline before any rebuild', async t => {
  const f = await fixture(t, [validReview('PASS')]);
  const first = await createModelingPipeline(f.options).prepare();
  await fs.appendFile(path.join(f.options.project, first.assets[0].files[0].path), 'changed');
  await assert.rejects(createModelingPipeline(f.options).prepare({ iteration: 2 }), error => error.kind === 'INTEGRITY_ERROR');
  assert.equal(f.counts.author, 1);
});

test('committed revision outcome resumes after interruption before updating the base plan', async t => {
  const f = await fixture(t, [validReview('PASS')]);
  await createModelingPipeline(f.options).prepare();
  await atomicJson(path.join(f.options.project, 'plan/modeling-request.json'), { reason: 'Addition', assets: [spec, { ...spec, assetId: 'addition' }] });
  await assert.rejects(createModelingPipeline({ ...f.options, onReport: async ({ file }) => {
    if (file.endsWith('revision-outcome-2.json')) throw Object.assign(new Error('interrupted after outcome'), { stopConfirmed: false });
  } }).prepare({ iteration: 2 }), /interrupted after outcome/);
  f.options.check = async () => ({ passed: true, smallEditsOnly: true, feedback: validReview('PASS') });
  const resumed = await createModelingPipeline(f.options).prepare({ iteration: 2 });
  assert.deepEqual(resumed.assets.map(asset => asset.assetId), ['fixture', 'addition']);
  assert.equal((await readJson(path.join(f.options.project, 'plan/modeling-specs.json'))).assets.length, 2);
});

test('later revisions queue behind unresolved requirements and survive same-round resumption', async t => {
  const f = await fixture(t, [validReview('PASS')]);
  const initial = createModelingPipeline(f.options); await initial.prepare();
  await atomicJson(path.join(f.options.project, 'plan/modeling-request.json'), { reason: 'First addition', assets: [spec, { ...spec, assetId: 'addition', maxTriangles: null }] });
  await initial.deferRequest();
  let repaired = false;
  const evaluate = f.options.evaluate;
  f.options.evaluate = async context => context.name === 'modeling-revision' ? {
    reason: 'First addition', assets: repaired ? [spec, { ...spec, assetId: 'addition' }] : [spec],
  } : evaluate(context);
  const blocked = createModelingPipeline(f.options); await blocked.prepare({ iteration: 2 });
  await atomicJson(path.join(f.options.project, 'plan/modeling-request.json'), { reason: 'Second addition', assets: [spec, { ...spec, assetId: 'addition' }, { ...spec, assetId: 'later' }] });
  await blocked.deferRequest();
  await createModelingPipeline(f.options).prepare({ iteration: 2 });
  repaired = true;
  f.options.check = async () => ({ passed: true, smallEditsOnly: true, feedback: validReview('PASS') });
  assert.deepEqual((await createModelingPipeline(f.options).prepare({ iteration: 3 })).assets.map(asset => asset.assetId), ['fixture', 'addition']);
  await createModelingPipeline(f.options).prepare({ iteration: 3 });
  assert.deepEqual((await createModelingPipeline(f.options).prepare({ iteration: 4 })).assets.map(asset => asset.assetId), ['fixture', 'addition', 'later']);
});

test('repairing an overlong revision prompt preserves legacy zero tolerances and original obligations', async t => {
  const f = await fixture(t, [validReview('PASS')]);
  const original = { ...spec, contract: defaultContract({ traversal: null, pivot: { mode: 'base-center', meters: null, toleranceMeters: 0 } }) };
  const task = path.join(f.root, 'modeling-state/tasks', hashValue({ taskId: 'task', workspaceId: 'workspace' }));
  await atomicJson(path.join(task, 'plan.json'), { reason: 'Frozen', assets: [original] });
  await atomicJson(path.join(f.options.project, 'plan/modeling-request.json'), { reason: 'Coverage repair', assets: [{ ...original, prompt: 'Retained history. '.repeat(100) }] });
  let repairs = 0;
  f.options.probe = async () => ({ blenderMcpAvailable: false });
  f.options.evaluate = async ({ name, schema }) => {
    assert.equal(name, 'modeling-revision'); repairs++;
    for (const variant of schema.properties.assets.items.anyOf.filter(item => item.properties.contract)) assert.equal(variant.properties.contract.anyOf[0].properties.pivot.properties.toleranceMeters.minimum, 0);
    return { reason: 'Compact the current action; retain frozen obligations', assets: [{ ...original, prompt: 'Replace the remaining visible temporary geometry.' }] };
  };
  await createModelingPipeline(f.options).prepare({ iteration: 2 });
  const result = await readJson(path.join(task, 'revision-outcome-2.json'));
  assert.equal(result.status, 'APPLIED'); assert.equal(repairs, 1);
  assert.deepEqual(result.appliedPlan.assets[0].contract, original.contract);
  assert.deepEqual(result.appliedPlan.assets[0].requirements, original.requirements);
  assert.ok(JSON.parse(result.rawRequest).assets[0].prompt.length > 1024);
});

test('changing a repair prompt cannot restart the same revision asset author budget', async t => {
  const f = await fixture(t, [validReview('PASS')]); f.options.job.revisionId = 'bounded';
  f.options.build = async () => { f.counts.author++; throw new Error('Invalid authored output'); };
  await createModelingPipeline(f.options).prepare();
  assert.equal(f.counts.author, 3);
  await atomicJson(path.join(f.options.project, 'plan/modeling-request.json'), { reason: 'Repair', assets: [{ ...spec, prompt: 'Correct the shape in this revision' }] });
  const result = await createModelingPipeline(f.options).prepare({ iteration: 2 });
  assert.equal(result.assets[0].status, 'NO_USABLE_ARTIFACT'); assert.equal(f.counts.author, 3);
});

test('coverage-first hands off one usable replacement per missing asset before spending attempts on detail', async t => {
  const f = await fixture(t, [validReview('GAP')]);
  f.options.job.objective = '先将场景所有白模、placeholder、地形全部建模和做材质，然后再逐个提升细节质量。';
  f.options.job.modelingSpecs.push({ ...spec, assetId: 'other' });
  await atomicJson(path.join(f.options.project, 'acceptance/scene-coverage.json'), { taskId: 'task', workspaceId: 'workspace', runId: 'old', iteration: 1,
    actors: ['fixture', 'other'].map(assetId => ({ label: assetId, assetId, category: 'visible-engine-native-temporary' })),
    engineNativeProvisionalActors: ['fixture', 'other'], missingOrDefaultMaterialActors: [], finalBlenderSourceCompliance: 'GAP' });
  f.options.check = async () => ({ passed: false, kind: 'VISUAL_GAP', smallEditsOnly: true, feedback: validReview('GAP') });
  const result = await createModelingPipeline(f.options).prepare();
  assert.deepEqual(result.assets.map(asset => asset.status), ['DCC_PROVISIONAL', 'DCC_PROVISIONAL']);
  assert.equal(f.counts.author, 2);
});
