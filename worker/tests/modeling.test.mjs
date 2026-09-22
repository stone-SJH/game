import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTripoProvider, tripoAvailability } from '../agent/providers/tripo.mjs';
import { createModelingPipeline } from '../agent/modeling-pipeline.mjs';
import { selectModelingRoute, reviewPasses, modelingInvocationArgs, visualSchemaFor, validateSchema } from '../agent/modeling-evaluation.mjs';
import { atomicJson, readJson, hashFile, localPath, agentEnvironment } from '../agent/modeling-io.mjs';
import { buildAssetCatalog } from '../agent/asset-catalog.mjs';
import { runProductionHarness } from '../agent/production-harness.mjs';

const spec = { assetId: 'lantern', description: 'A red lantern', prompt: 'A red paper lantern with a brass frame',
  requirements: ['Round red body', 'Brass frame'], referenceImages: [], maxTriangles: 30000, requireRig: false, requireClosedMesh: false };
const predictions = spec.requirements.map(criterion => ({ criterion, achievable: true, evidence: 'Shape and materials can be authored with bpy.' }));
const success = { exitCode: 0, stdout: '', stderr: '', stopConfirmed: true, timedOut: false };
function advice(enabled = true) {
  return { complexity: 'medium', precision: 'Recognizable silhouette', qualityTarget: 'Game prop', capabilityCoverage: 'bpy primitives and materials', unknowns: [], confidence: 0.9,
    candidates: [], direct: { canMeetQuality: true, estimatedMinutes: 40, plan: ['Model the body and frame'], qualityByCriterion: predictions },
    thirdParty: { assessed: enabled, preferred: enabled, smallEditsOnly: true, editMinutes: 5, editPlan: ['Scale and apply materials'], qualityByCriterion: enabled ? predictions : [], reason: enabled ? 'Organic shape benefits from generation' : 'Provider disabled' },
    rationale: 'Choose the feasible route.' };
}
async function fixture(t, withKey = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modeling 中文 '));
  const project = path.join(root, 'project'), output = path.join(root, 'run');
  await fs.mkdir(project); await fs.mkdir(output);
  const keyFile = path.join(root, 'tripo.txt');
  if (withKey) await fs.writeFile(keyFile, '\uFEFFtsk_test_credential\r\n');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const providerArgs = { repoRoot: root, keyFile, pollMs: 1, maxWaitMs: 2000, requestTimeoutMs: 500 };
  const generation = { project, directory: 'art/generated', stateFile: path.join(root, 'provider-state.json'), ledgerFile: path.join(output, 'ledger.json'),
    assetId: 'lantern', prompt: spec.prompt, requirementsHash: 'requirements', signal: new AbortController().signal };
  return { root, project, output, keyFile, providerArgs, generation };
}
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
function glb() {
  const value = Buffer.alloc(24); value.write('glTF'); value.writeUInt32LE(2, 4); value.writeUInt32LE(24, 8); return value;
}
function readyFetch(calls) {
  return async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'POST') return json({ code: 0, data: { task_id: 'task_one' } });
    if (url.includes('/tasks/')) return json({ code: 0, data: { status: 'success', output: { model_url: 'https://cdn.tripo3d.ai/model.glb?signature=private' }, credits_consumed: 10 } });
    return new Response(glb());
  };
}

test('missing/empty key disables provider without network; BOM keys work and values are private', async t => {
  const f = await fixture(t, false); let calls = 0;
  const provider = createTripoProvider({ ...f.providerArgs, fetchImpl: async () => { calls++; throw new Error('Unexpected network'); } });
  assert.equal((await provider.availability()).enabled, false);
  assert.equal((await provider.generate(f.generation)).reasonCode, 'key_file_missing');
  await fs.writeFile(f.keyFile, ' \r\n');
  assert.equal((await provider.balance()).reasonCode, 'key_file_empty');
  await fs.writeFile(f.keyFile, '\uFEFFtsk_test_credential\r\n');
  const available = await provider.availability();
  assert.equal(available.enabled, true); assert.equal(JSON.stringify(available).includes('tsk_'), false);
  assert.equal(calls, 0);
  assert.deepEqual(agentEnvironment({ TRIPO_API_KEY: 'secret', TRIPO_API_KEY_FILE: 'secret-path', WORKER_TOKEN: 'secret', PATH: 'ok' }), { PATH: 'ok' });
});

for (const [status, code, reason] of [[403, 2010, 'insufficient_credits'], [401, 1000, 'authentication'], [403, 1, 'forbidden'], [429, 2000, 'rate_limited'], [503, 0, 'service_unavailable'], [200, 2010, 'insufficient_credits']]) {
  test(`Tripo ${status}/${code} falls back and never repeats a paid POST`, async t => {
    const f = await fixture(t); let calls = 0;
    const provider = createTripoProvider({ ...f.providerArgs, fetchImpl: async () => { calls++; return json({ code, message: 'tsk_test_credential' }, status); } });
    const result = await provider.generate(f.generation);
    assert.equal(result.status, 'unavailable'); assert.equal(result.reasonCode, reason);
    assert.equal((await provider.generate(f.generation)).status, 'unavailable');
    assert.equal(calls, 1);
    assert.equal((await fs.readFile(f.generation.stateFile, 'utf8')).includes('tsk_test_credential'), false);
  });
}

test('valid download is hashed, unauthenticated on CDN, and reused without resubmission', async t => {
  const f = await fixture(t), calls = [];
  const provider = createTripoProvider({ ...f.providerArgs, fetchImpl: readyFetch(calls) });
  const result = await provider.generate(f.generation);
  assert.equal(result.status, 'ready'); assert.equal(calls.length, 3);
  assert.equal(calls[2].options.headers, undefined);
  assert.equal(result.sha256, await hashFile(path.join(f.project, result.modelFile)));
  assert.equal((await provider.generate(f.generation)).sha256, result.sha256);
  assert.equal(calls.length, 3);
  assert.doesNotMatch(await fs.readFile(f.generation.stateFile, 'utf8'), /signature=private|tsk_test/);
});

test('unknown POST outcome survives new provider instances without repeat submission', async t => {
  const f = await fixture(t); let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('network contains tsk_test_credential'); };
  assert.equal((await createTripoProvider({ ...f.providerArgs, fetchImpl }).generate(f.generation)).submissionUnknown, true);
  assert.equal((await createTripoProvider({ ...f.providerArgs, fetchImpl }).generate(f.generation)).status, 'unavailable');
  assert.equal(calls, 1);
});

for (const kind of ['invalid-glb', 'missing-url', 'failed-task', 'unknown-status', 'invalid-json', 'external-redirect']) {
  test(`unusable result ${kind} returns a Blender fallback`, async t => {
    const f = await fixture(t);
    const provider = createTripoProvider({ ...f.providerArgs, fetchImpl: async (url, options) => {
      if (options.method === 'POST') return json({ code: 0, data: { task_id: 'task_one' } });
      if (url.includes('/tasks/')) {
        if (kind === 'invalid-json') return new Response('<html>unavailable</html>');
        const status = kind === 'failed-task' ? 'failed' : kind === 'unknown-status' ? 'unexpected' : 'success';
        return json({ code: 0, data: { status, output: kind === 'missing-url' ? {} : { model_url: 'https://cdn.tripo3d.ai/model.glb' } } });
      }
      return kind === 'external-redirect' ? new Response(null, { status: 302, headers: { location: 'https://attacker.example/model.glb' } }) : new Response('invalid');
    } });
    assert.equal((await provider.generate(f.generation)).status, 'unavailable');
  });
}

test('poll timeout falls back and outer cancellation propagates', async t => {
  const f = await fixture(t), controller = new AbortController(); let posts = 0;
  const provider = createTripoProvider({ ...f.providerArgs, maxWaitMs: 30, fetchImpl: async (url, options) => {
    if (options.method === 'POST') { posts++; return json({ code: 0, data: { task_id: 'task_one' } }); }
    return json({ code: 0, data: { status: 'running' } });
  } });
  assert.equal((await provider.generate(f.generation)).reasonCode, 'provider_timeout');
  controller.abort(new Error('operator canceled'));
  await assert.rejects(provider.generate({ ...f.generation, signal: controller.signal }), /operator canceled/);
  assert.equal(posts, 1);
});

test('canceled polling resumes the durable task ID without a second paid submission', async t => {
  const f = await fixture(t), controller = new AbortController(); let posts = 0;
  const provider = createTripoProvider({ ...f.providerArgs, fetchImpl: async (url, options) => {
    if (options.method === 'POST') { posts++; return json({ code: 0, data: { task_id: 'task_one' } }); }
    controller.abort(new Error('pause provider poll'));
    return json({ code: 0, data: { status: 'running' } });
  } });
  await assert.rejects(provider.generate({ ...f.generation, signal: controller.signal }), /pause provider poll/);
  assert.equal((await readJson(f.generation.stateFile)).taskId, 'task_one');
  const resumedCalls = [];
  const resumed = createTripoProvider({ ...f.providerArgs, fetchImpl: readyFetch(resumedCalls) });
  assert.equal((await resumed.generate(f.generation)).status, 'ready');
  assert.equal(posts, 1);
  assert.equal(resumedCalls.some(call => call.options.method === 'POST'), false);
});

test('run budget covers different assets and missing key at generation time makes no request', async t => {
  const f = await fixture(t), calls = [];
  const provider = createTripoProvider({ ...f.providerArgs, fetchImpl: readyFetch(calls) });
  assert.equal((await provider.generate(f.generation)).status, 'ready');
  const second = { ...f.generation, assetId: 'other', requirementsHash: 'other-requirements', directory: 'art/other', stateFile: path.join(f.root, 'other-state.json') };
  assert.equal((await provider.generate(second)).reasonCode, 'generation_budget_exhausted');
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  await fs.unlink(f.keyFile);
  assert.equal((await provider.generate(second)).reasonCode, 'key_file_missing');
  assert.equal(calls.length, 3);
});

test('reference-bound review schema excludes extra criteria and rejects duplicate or omitted requirements', () => {
  const review = { criteria: spec.requirements.map(criterion => ({ criterion, status: 'PASS', evidence: 'Visible in export views' })), smallEditsOnly: true, repairInstructions: '' };
  validateSchema(review, visualSchemaFor(spec));
  assert.equal(reviewPasses(review, spec), true);
  assert.throws(() => validateSchema({ ...review, criteria: [...review.criteria, { ...review.criteria[0], criterion: 'Extra triangle requirement' }] }, visualSchemaFor(spec)), /Invalid/);
  assert.throws(() => reviewPasses({ ...review, criteria: [review.criteria[0], review.criteria[0]] }, spec), /every original/);
});

test('reuse has priority; missing key skips third-party assessment; generated full rebuild is rejected', () => {
  const assessment = advice();
  assessment.candidates = [{ assetId: 'existing', similarity: 0.9, canMeetQuality: true, editPlan: ['Recolor'], qualityByCriterion: predictions, reason: 'Close shape' }];
  const context = { spec, candidates: [{ assetId: 'existing', previewImages: ['preview.png'] }], providerEnabled: true };
  assert.equal(selectModelingRoute(assessment, context).route, 'reuse_blender');
  assert.throws(() => selectModelingRoute(assessment, { ...context, providerEnabled: false }), /skipped/);
  assert.equal(selectModelingRoute(advice(false), { spec, candidates: [], providerEnabled: false }).route, 'blender_direct');
  const rebuild = advice(); rebuild.thirdParty.smallEditsOnly = false;
  assert.equal(selectModelingRoute(rebuild, { spec, candidates: [], providerEnabled: true }).route, 'blender_direct');
  assert.throws(() => reviewPasses({ criteria: [{ criterion: 'Round red body', status: 'PASS', evidence: 'front' }], smallEditsOnly: true, repairInstructions: '' }, spec), /every original/);
  const args = modelingInvocationArgs({ args: [] }, 'project', 'schema.json', 'response.json', ['front.png']);
  assert.equal(args[args.indexOf('--image') + 1], 'front.png');
  assert.ok(args.includes('features.shell_tool=false'));
});

async function pipelineFixture(t, { enabled = true, generated = 'unavailable', visualGap = false, invalidEvaluator = false } = {}) {
  const f = await fixture(t); const calls = [], controller = new AbortController();
  const options = { job: { taskId: 'task', workspaceId: 'workspace', runId: 'run', objective: 'Model a lantern', modelingSpecs: [spec] },
    project: f.project, output: f.output, signal: controller.signal, invocation: { command: process.execPath, args: [] }, step: async () => success,
    probe: async () => ({ blenderMcpAvailable: true }),
    checkBase: async () => ({ smallEditsOnly: true, sourcePreviews: [] }),
    provider: { availability: async () => ({ enabled }), generate: async () => {
      calls.push('provider'); return generated === 'ready' ? { status: 'ready', modelFile: 'generated.glb' } : { status: 'unavailable', reasonCode: 'insufficient_credits' };
    } },
    evaluate: async () => { calls.push('evaluate'); if (invalidEvaluator) throw new Error('invalid JSON'); return advice(enabled); },
    build: async ({ directory, decision }) => {
      calls.push(`build:${decision.route}`);
      await fs.writeFile(path.join(f.project, directory, 'source.blend'), 'fixture source');
      await fs.writeFile(path.join(f.project, directory, 'model.glb'), glb());
      await atomicJson(path.join(f.project, directory, 'build-report.json'), { smallEditsOnly: true });
    },
    check: async ({ decision }) => { calls.push(`check:${decision.route}`); return { passed: !(visualGap && decision.route === 'tripo_then_blender'), smallEditsOnly: false, feedback: 'Wrong silhouette' }; },
  };
  return { ...f, options, calls, controller, pipeline: createModelingPipeline(options) };
}

test('missing key evaluates locally and still authors and checks the asset', async t => {
  const f = await pipelineFixture(t, { enabled: false });
  const summary = await f.pipeline.prepare();
  assert.equal(summary.assets[0].route, 'blender_direct');
  assert.deepEqual(f.calls, ['evaluate', 'build:blender_direct', 'check:blender_direct']);
  await f.pipeline.verify();
});

test('third-party outage completes via Blender and accepted models survive retries', async t => {
  const f = await pipelineFixture(t);
  const summary = await f.pipeline.prepare();
  assert.equal(summary.assets[0].originalRoute, 'tripo_then_blender');
  assert.equal(summary.assets[0].route, 'blender_direct');
  assert.deepEqual(f.calls, ['evaluate', 'provider', 'build:blender_direct', 'check:blender_direct']);
  const restarted = createModelingPipeline(f.options);
  assert.equal((await restarted.prepare()).assets[0].reused, true);
  assert.equal(f.calls.length, 4);
});

test('generated output failing visual quality goes directly to Blender with the same requirements', async t => {
  const f = await pipelineFixture(t, { generated: 'ready', visualGap: true });
  const build = f.options.build;
  f.options.build = async context => {
    if (context.decision.route === 'blender_direct') { assert.equal(context.sourceFile, null); assert.equal(context.previousAttemptDirectory, null); }
    return build(context);
  };
  const result = await createModelingPipeline(f.options).prepare();
  assert.equal(result.assets[0].route, 'blender_direct');
  assert.deepEqual(f.calls, ['evaluate', 'provider', 'build:tripo_then_blender', 'check:tripo_then_blender', 'build:blender_direct', 'check:blender_direct']);
});

test('unusable generated base skips cleanup; a full rebuild cannot pass as generated cleanup', async t => {
  const base = await pipelineFixture(t, { generated: 'ready' });
  base.options.checkBase = async () => ({ smallEditsOnly: false });
  assert.equal((await createModelingPipeline(base.options).prepare()).assets[0].route, 'blender_direct');
  assert.equal(base.calls.includes('build:tripo_then_blender'), false);
  const edited = await pipelineFixture(t, { generated: 'ready' });
  edited.options.check = async ({ decision }) => ({ passed: true, smallEditsOnly: decision.route !== 'tripo_then_blender' });
  assert.equal((await createModelingPipeline(edited.options).prepare()).assets[0].route, 'blender_direct');
  assert.equal(edited.calls.filter(name => name === 'provider').length, 1);
});

test('registered source is copied before editing; failed reuse advances to new-build evaluation once', async t => {
  const f = await pipelineFixture(t, { enabled: false });
  await fs.mkdir(path.join(f.project, 'art'));
  await fs.writeFile(path.join(f.project, 'art/existing.blend'), 'original editable asset');
  await fs.writeFile(path.join(f.project, 'art/preview.png'), 'fixture preview');
  await atomicJson(path.join(f.project, 'provenance/modeling-catalog.json'), { assets: [{
    path: 'art/existing.blend', source: 'task authored', license: 'task authored', previewImages: ['art/preview.png'],
  }] });
  const sourceHash = await hashFile(path.join(f.project, 'art/existing.blend'));
  let evaluations = 0;
  f.options.evaluate = async ({ prompt }) => {
    const candidates = JSON.parse(prompt.split('\n').find(line => line.startsWith('Candidates: ')).slice(12));
    const assessment = advice(false); evaluations++;
    assessment.candidates = candidates.map(item => ({ assetId: item.assetId, similarity: 0.95, canMeetQuality: true, editPlan: ['Recolor'], qualityByCriterion: predictions, reason: 'Similar shape' }));
    return assessment;
  };
  const build = f.options.build;
  f.options.build = async context => {
    if (context.decision.route === 'reuse_blender') {
      assert.notEqual(context.sourceFile, 'art/existing.blend');
      assert.equal(await hashFile(path.join(f.project, context.sourceFile)), sourceHash);
    }
    await build(context);
  };
  f.options.check = async ({ decision }) => ({ passed: decision.route === 'blender_direct', smallEditsOnly: false, feedback: 'Source topology cannot meet the target' });
  const summary = await createModelingPipeline(f.options).prepare();
  assert.equal(summary.assets[0].originalRoute, 'reuse_blender');
  assert.equal(summary.assets[0].route, 'blender_direct');
  assert.equal(evaluations, 2);
  assert.equal(f.calls.filter(call => call === 'build:reuse_blender').length, 2);
  assert.equal(await hashFile(path.join(f.project, 'art/existing.blend')), sourceHash);
  const catalog = await buildAssetCatalog(f.project, spec);
  assert.ok(catalog.some(item => item.path.endsWith('blender_direct-1/source.blend')));
});

test('provider outage disables third-party assessment for subsequent assets', async t => {
  const f = await pipelineFixture(t);
  f.options.job.modelingSpecs = [spec, { ...spec, assetId: 'second-lantern' }];
  const enabledStates = [];
  f.options.evaluate = async ({ prompt }) => {
    const enabled = !prompt.includes('Third-party generation is disabled.');
    enabledStates.push(enabled);
    const assessment = advice(enabled);
    const candidates = JSON.parse(prompt.split('\n').find(line => line.startsWith('Candidates: ')).slice(12));
    assessment.candidates = candidates.map(item => ({ assetId: item.assetId, similarity: 0, canMeetQuality: false, editPlan: [], qualityByCriterion: predictions, reason: 'No usable source evidence' }));
    return assessment;
  };
  const summary = await createModelingPipeline(f.options).prepare();
  assert.equal(summary.assets.length, 2);
  assert.deepEqual(enabledStates, [true, false]);
  assert.equal(f.calls.filter(call => call === 'provider').length, 1);
});

test('failed direct quality stops at the modeling budget instead of accepting deficient output', async t => {
  const f = await pipelineFixture(t, { enabled: false }); let checks = 0;
  f.options.check = async () => { checks++; return { passed: false, smallEditsOnly: false, feedback: 'Missing required parts' }; };
  await assert.rejects(createModelingPipeline(f.options).prepare(), error => error.hardFailure === true && /quality budget exhausted/.test(error.message));
  assert.equal(checks, 3);
  assert.equal(await readJson(path.join(f.project, 'plan/modeling-results.json')), null);
});

test('evaluator unavailable falls back within two calls; unsafe stop never starts a build', async t => {
  const f = await pipelineFixture(t, { invalidEvaluator: true });
  assert.equal((await f.pipeline.prepare()).assets[0].route, 'blender_direct');
  assert.deepEqual(f.calls, ['evaluate', 'evaluate', 'build:blender_direct', 'check:blender_direct']);
  const other = await pipelineFixture(t);
  other.options.evaluate = async () => { throw Object.assign(new Error('unsafe stop'), { stopConfirmed: false }); };
  await assert.rejects(createModelingPipeline(other.options).prepare(), /unsafe stop/);
  assert.equal(other.calls.length, 0);
});

test('an MCP receipt with unconfirmed shutdown stops without a replacement build', async t => {
  const f = await pipelineFixture(t, { enabled: false }); let authorCalls = 0;
  delete f.options.build;
  f.options.step = async (name, command, args) => {
    if (!name.startsWith('modeling-author')) throw new Error('Unexpected step');
    authorCalls++;
    assert.ok(args.includes('features.multi_agent=false'));
    const toml = args.find(arg => arg.startsWith('mcp_servers.yahaha_blender='));
    const serverArgs = JSON.parse(toml.match(/args=(\[.*\]), required=/)[1]);
    const receipt = serverArgs[serverArgs.indexOf('--receipt') + 1];
    await atomicJson(receipt, { calls: [{ tool: 'blender_run_python', exitCode: 1, stopConfirmed: false }] });
    return success;
  };
  await assert.rejects(createModelingPipeline(f.options).prepare(), error => error.stopConfirmed === false);
  assert.equal(authorCalls, 1);
});

test('cancellation during provider call stops, and acceptance artifacts cannot be changed', async t => {
  const f = await pipelineFixture(t);
  f.options.provider.generate = async () => { f.controller.abort(new Error('cancel task')); throw f.controller.signal.reason; };
  await assert.rejects(createModelingPipeline(f.options).prepare(), /cancel task/);
  assert.equal(f.calls.some(name => name.startsWith('build')), false);
  const other = await pipelineFixture(t, { enabled: false });
  const result = await other.pipeline.prepare();
  await fs.appendFile(path.join(other.project, result.assets[0].files[0].path), 'changed');
  await assert.rejects(other.pipeline.verify(), /artifact changed/);
});

test('revision cannot delete or weaken the original modeling requirements', async t => {
  const f = await pipelineFixture(t, { enabled: false }); await f.pipeline.prepare();
  await atomicJson(path.join(f.project, 'plan/modeling-request.json'), { reason: 'Weaken', assets: [{ ...spec, requirements: ['Round red body'] }] });
  await assert.rejects(f.pipeline.prepare(), /weaken original/);
});

test('catalog requires provenance and excludes workspace escapes and hash mismatches', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.project, 'art'));
  await fs.writeFile(path.join(f.project, 'art/model.glb'), glb());
  await atomicJson(path.join(f.project, 'provenance/modeling-catalog.json'), { assets: [
    { path: 'art/model.glb', source: 'authored', license: 'task owned' },
    { path: '../tripo.txt', source: 'bad', license: 'bad' }, { path: 'art/missing.glb' },
  ] });
  assert.equal((await buildAssetCatalog(f.project, spec)).length, 1);
  await assert.rejects(localPath(f.project, '../tripo.txt'), /Invalid/);
  await assert.rejects(localPath(f.project, 'C:\\outside\\asset.glb'), /Invalid/);
});

test('default harness runs modeling intake before main production; no-model tasks keep existing flow', async t => {
  const f = await fixture(t), calls = [];
  const saved = { CODEX_CMD: process.env.CODEX_CMD, CODEX_MAX_ATTEMPTS: process.env.CODEX_MAX_ATTEMPTS, MODELING_ROUTING_ENABLED: process.env.MODELING_ROUTING_ENABLED };
  process.env.CODEX_CMD = process.execPath; process.env.CODEX_MAX_ATTEMPTS = '1'; delete process.env.MODELING_ROUTING_ENABLED;
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  await assert.rejects(runProductionHarness({ job: { taskId: 'task', workspaceId: 'workspace', runId: 'run', objective: 'Fix game code only' },
    project: f.project, output: f.output, signal: new AbortController().signal, unreal: 'unused',
    step: async (name, command, args, timeout, cwd, accepts, options) => {
      calls.push(name);
      if (name.startsWith('modeling-plan')) await atomicJson(args[args.indexOf('-o') + 1], { reason: 'Only code repair', assets: [] });
      if (name.startsWith('production-orchestrator')) assert.match(options.input, /NOT_APPLICABLE/);
      return success;
    },
  }), /deliverables missing/);
  assert.ok(calls[0].startsWith('modeling-plan'));
  assert.ok(calls[1].startsWith('production-orchestrator'));
});
