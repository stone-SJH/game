import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createModelingPipeline } from '../agent/modeling-pipeline.mjs';
import { validateUnrealModels } from '../agent/modeling-unreal.mjs';
import { defaultContract } from '../agent/modeling-contract.mjs';
import { atomicJson, hashFile, readJson } from '../agent/modeling-io.mjs';

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
  for (let i = 0; i < 2; i++) await assert.rejects(createModelingPipeline(f.options).prepare(), e => e.kind === 'VALIDATION_INFRASTRUCTURE_EXHAUSTED' && e.hardFailure);
  assert.deepEqual(f.counts, { author: 1, technical: 1, review: 3 });
  const states = (await fs.readdir(path.join(f.root, 'modeling-state'))).filter(n => n !== 'tasks');
  const state = await readJson(path.join(f.root, 'modeling-state', states[0], 'state.json'));
  assert.equal(state.pending.phase, 'VISUAL_PENDING');
  assert.deepEqual(state.rejectedSources, []);
  assert.equal(state.attempts.reuse_blender, 1);
});

test('a valid visual GAP ends its review and starts a real repair', async t => {
  const f = await fixture(t, [validReview('GAP'), validReview('PASS')]);
  const result = await createModelingPipeline(f.options).prepare();
  assert.deepEqual(f.counts, { author: 2, technical: 2, review: 2 });
  assert.equal(result.assets[0].failures[0].kind, 'VISUAL_GAP');
});

test('all author executions failing do not mislabel a reuse quality gap', async t => {
  const f = await fixture(t, [validReview('PASS')], true);
  f.options.build = async () => { f.counts.author++; throw new Error('author service unavailable'); };
  await assert.rejects(createModelingPipeline(f.options).prepare(), e => e.kind === 'AUTHOR_EXECUTION_EXHAUSTED');
  assert.deepEqual(f.counts, { author: 2, technical: 0, review: 0 });
});

test('Unreal visual retries and resumed acceptance reuse the original capture and import', async t => {
  const f = await fixture(t, [validReview('PASS')]), { project, output, signal, invocation } = f.options;
  const assetSpec = { ...spec, contract: defaultContract({ runtime: { engine: 'unreal', profile: 'glb-static', collision: 'none', lodTriangles: [], sockets: [], animations: [], lightmapUV: false } }) };
  await fs.mkdir(path.join(project, 'Content'), { recursive: true });
  const projectFile = path.join(project, 'Test.uproject'); await fs.writeFile(projectFile, '{}');
  await fs.mkdir(path.join(project, 'model'));
  await fs.writeFile(path.join(project, 'model/model.glb'), 'export');
  await atomicJson(path.join(project, 'model/geometry-report.json'), { export: { dimensions: [1,1,1] }, source: { gates: [] } });
  await atomicJson(path.join(project, 'plan/modeling-engine-imports.json'), { protocol: 2, assets: [{ assetId: 'fixture', packagePath: '/Game/Fixture.Fixture', mapPath: '/Game/Test' }] });
  const asset = { assetId: 'fixture', requirementsHash: 'requirements', spec: assetSpec, contract: assetSpec.contract,
    files: [{ path: 'model/model.glb', sha256: await hashFile(path.join(project, 'model/model.glb')) }, { path: 'model/geometry-report.json' }] };
  let technical = 0, reviews = 0;
  const options = { project, output, signal, invocation, projectFile, unreal: 'fixture', attempt: 1, summary: { assets: [asset] },
    evaluate: async () => ++reviews < 3 ? { wrong: 'PASS' } : validReview('PASS'),
    step: async (name, command, args) => {
      technical++;
      const wrapper = args.find(a => a.startsWith('-script=')).slice(8), directory = path.dirname(wrapper);
      const image = path.join(directory, 'front.png'); await fs.writeFile(image, 'frozen screenshot');
      await atomicJson(path.join(directory, 'report.json'), { requestHash: await hashFile(path.join(directory, 'request.json')), passed: true,
        assets: [{ assetId: 'fixture', requirementsHash: 'requirements', passed: true, views: [{ file: image, sha256: await hashFile(image) }] }] });
      return ok;
    } };
  assert.equal((await validateUnrealModels(options)).status, 'ENGINE_READY');
  assert.equal((await validateUnrealModels({ ...options, attempt: 2 })).status, 'ENGINE_READY');
  assert.equal(technical, 1); assert.equal(reviews, 3);
});
