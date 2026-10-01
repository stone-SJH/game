import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { imageGenerationSettings, imageGenerationCredential } from '../agent/modeling-image-settings.mjs';
import { createModelingImageProvider, checkConceptPng } from '../agent/modeling-image-provider.mjs';
import { prepareModelingConcept, retainConceptInputRejection } from '../agent/modeling-concept.mjs';
import { createTripoProvider } from '../agent/providers/tripo.mjs';
import { selectModelingRoute, validateSchema } from '../agent/modeling-evaluation.mjs';
import { createModelingPipeline } from '../agent/modeling-pipeline.mjs';
import { defaultContract } from '../agent/modeling-contract.mjs';
import { modelingRuntimeIdentity } from '../agent/modeling-runtime-lock.mjs';
import { atomicJson, hashFile, readJson, agentEnvironment } from '../agent/modeling-io.mjs';

const criteria = ['subject-and-identity', 'anatomy-and-proportions', 'silhouette-and-detail', 'clean-single-subject-view', 'reference-fidelity'];
const verdict = (status = 'PASS') => ({ criteria: criteria.map(criterion => ({ criterion, status, evidence: 'Observed full subject and visible limbs.' })),
  repairInstructions: status === 'GAP' ? 'Correct the missing hind leg.' : '' });
const spec = { assetId: 'fox', description: 'High quality silver fox', prompt: 'Detailed silver fox with four visible legs',
  requirements: ['Four anatomically coherent legs', 'Layered silver fur'], referenceImages: [], maxTriangles: 30000,
  requireRig: true, requireClosedMesh: false, contract: defaultContract({ assetClass: 'skeletal-character',
    runtime: { ...defaultContract().runtime, profile: 'fbx-skeletal', animations: ['Walk'] } }) };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
function png(color = 100) {
  const crc = buffer => {
    let value = 0xffffffff;
    for (const byte of buffer) {
      value ^= byte;
      for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const output = Buffer.alloc(data.length + 12);
    output.writeUInt32BE(data.length); output.write(type, 4); data.copy(output, 8);
    output.writeUInt32BE(crc(output.subarray(4, -4)), output.length - 4); return output;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(256); header.writeUInt32BE(256, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(256 * (1 + 256 * 3), color);
  for (let i = 0; i < 256; i++) pixels[i * (1 + 256 * 3)] = 0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
function glb() {
  const value = Buffer.alloc(24); value.write('glTF'); value.writeUInt32LE(2, 4); value.writeUInt32LE(24, 8); return value;
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-first-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), output = path.join(root, 'run');
  await fs.mkdir(project); await fs.mkdir(output);
  const settings = async () => ({ endpoint: 'http://router.test/v1/images/generations',
    identity: { model: 'gpt-image-2', size: '2048x2048', timeoutMs: 2000 } });
  const credential = async () => 'private-image-key';
  const generation = { project, directory: 'art/concept', stateFile: path.join(root, 'image.json'),
    prompt: 'One detailed fox.', requirementsHash: 'original' };
  return { root, project, output, settings, credential, generation };
}
function advice(current = spec, enabled = true) {
  const predictions = current.requirements.map(criterion => ({ criterion, achievable: true, evidence: 'Can be authored.' }));
  return { complexity: 'high', precision: 'Visible anatomy', qualityTarget: 'Detailed game character',
    capabilityCoverage: 'Blender rig and exports', unknowns: [], confidence: .9, candidates: [],
    direct: { canMeetQuality: true, estimatedMinutes: 90, plan: ['Author requested shape'], qualityByCriterion: predictions },
    thirdParty: { assessed: enabled, preferred: false, smallEditsOnly: false, editMinutes: 40,
      editPlan: ['Rig the generated anatomy'], qualityByCriterion: enabled ? predictions : [], reason: 'Requires rigging' }, rationale: 'Preserve original requirements.' };
}
async function conceptFixture(t, statuses = ['PASS'], sameBytes = false) {
  const f = await fixture(t); const events = [];
  const imageProvider = createModelingImageProvider({ settings: f.settings, credential: f.credential, fetchImpl: async () => {
    events.push('image'); return json({ data: [{ b64_json: png(sameBytes ? 100 : 100 + events.length).toString('base64') }] });
  } });
  let reviews = 0;
  const review = async (name, schema, prompt, images, options) => {
    events.push('review');
    const result = verdict(statuses[Math.min(reviews++, statuses.length - 1)]);
    validateSchema(result, schema); await options.validate(result); return result;
  };
  const args = { spec, project: f.project, taskState: path.join(f.root, 'task'), short: 'frozen', iteration: 1,
    job: {}, signal: new AbortController().signal, reportProgress: async () => {}, imageProvider, review };
  return { ...f, events, args };
}

test('image router resolves selected Codex provider, pins budgets and never shares auth with an override host', async t => {
  const f = await fixture(t), directory = path.join(f.root, 'codex');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'config.toml'), 'model_provider = "OpenAI"\n[model_providers."OpenAI"]\nbase_url = "http://local.test/v1"\n');
  await atomicJson(path.join(directory, 'auth.json'), { OPENAI_API_KEY: 'private-router-auth' });
  const settings = await imageGenerationSettings({ CODEX_HOME: directory, MODELING_IMAGE_TIMEOUT_MS: '1234', TRIPO_MAX_IMAGE_GENERATIONS_PER_ITERATION: '12' });
  assert.equal(settings.endpoint, 'http://local.test/v1/images/generations');
  assert.equal(settings.identity.model, 'gpt-image-2'); assert.equal(settings.identity.timeoutMs, 1234);
  assert.equal(settings.identity.maxImageGenerations, 12);
  assert.equal(await imageGenerationCredential(settings), 'private-router-auth');
  assert.doesNotMatch(JSON.stringify(settings.identity), /private|local.test/);
  const override = await imageGenerationSettings({ CODEX_HOME: directory, MODELING_IMAGE_BASE_URL: 'https://other.test/v1' });
  assert.equal(await imageGenerationCredential(override), null);
  const explicit = await imageGenerationSettings({ CODEX_HOME: directory, MODELING_IMAGE_BASE_URL: 'https://other.test/v1', MODELING_IMAGE_API_KEY: 'explicit-private-key' });
  assert.equal(await imageGenerationCredential(explicit), 'explicit-private-key');
  assert.deepEqual(agentEnvironment({ MODELING_IMAGE_API_KEY: 'secret', MODELING_IMAGE_API_KEY_FILE: 'secret-path', PATH: 'ok' }), { PATH: 'ok' });
});

test('GPT Image 2 posts once to the local API and resumes verified output without another charge', async t => {
  const f = await fixture(t), calls = [];
  const provider = createModelingImageProvider({ settings: f.settings, credential: f.credential, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return json({ data: [{ b64_json: png().toString('base64') }] });
  } });
  const result = await provider.generate(f.generation);
  assert.equal(result.status, 'ready'); assert.equal(result.width, 256);
  assert.equal(calls[0].url, 'http://router.test/v1/images/generations');
  assert.deepEqual(JSON.parse(calls[0].options.body), { model: 'gpt-image-2', prompt: f.generation.prompt, n: 1, size: '2048x2048', quality: 'high', output_format: 'png' });
  assert.equal((await provider.generate(f.generation)).sha256, result.sha256); assert.equal(calls.length, 1);
  assert.doesNotMatch(await fs.readFile(f.generation.stateFile, 'utf8'), /private-image-key/);
  await fs.appendFile(path.join(f.project, result.imageFile), 'changed');
  await assert.rejects(provider.generate(f.generation), error => error.kind === 'INTEGRITY_ERROR');
});

for (const mode of ['http', 'invalid-png', 'network', 'cancel']) {
  test('image ' + mode + ' retains its submission and never blindly repeats it', async t => {
    const f = await fixture(t), controller = new AbortController(); let calls = 0;
    const provider = createModelingImageProvider({ settings: f.settings, credential: f.credential, fetchImpl: async () => {
      calls++;
      if (mode === 'http') return json({ message: 'private-image-key' }, 400);
      if (mode === 'invalid-png') return json({ data: [{ b64_json: Buffer.from('not an image').toString('base64') }] });
      if (mode === 'cancel') controller.abort(new Error('operator pause'));
      throw new Error('private-image-key');
    } });
    if (mode === 'cancel') await assert.rejects(provider.generate({ ...f.generation, signal: controller.signal }), /operator pause/);
    else await assert.rejects(provider.generate(f.generation), error => error.kind === (mode === 'http' ? 'SERVICE_CONFIGURATION' : 'SERVICE_TRANSIENT'));
    await assert.rejects(provider.generate(f.generation), error => error.retrySafe === false); assert.equal(calls, 1);
    assert.doesNotMatch(await fs.readFile(f.generation.stateFile, 'utf8'), /private-image-key/);
  });
}

test('image HTTP outages recover within one concept without spending a quality iteration', async t => {
  const f = await fixture(t), waits = [], progress = []; let calls = 0, clock = Date.now();
  const provider = createModelingImageProvider({ settings: f.settings, credential: f.credential,
    recoveryOptions: { now: () => clock, wait: async ms => { waits.push(ms); clock += ms; } },
    fetchImpl: async () => {
      calls++;
      return calls < 3 ? json({ message: 'private-image-key' }, calls === 1 ? 502 : 503)
        : json({ data: [{ b64_json: png().toString('base64') }] });
    } });
  const result = await provider.generate({ ...f.generation, onWaiting: async value => progress.push(value) });
  assert.equal(result.status, 'ready'); assert.equal(calls, 3); assert.equal(result.history.length, 2);
  assert.deepEqual(waits, [5000, 10000]); assert.ok(progress.every(row => row.phase === 'waiting_service'));
  assert.equal((await provider.generate(f.generation)).sha256, result.sha256); assert.equal(calls, 3);
  assert.doesNotMatch(await fs.readFile(f.generation.stateFile, 'utf8'), /private-image-key/);
});

test('image service budget survives resumes and never becomes a quality GAP', async t => {
  const f = await fixture(t); let calls = 0, clock = Date.now();
  const provider = createModelingImageProvider({ settings: f.settings, credential: f.credential,
    recoveryOptions: { now: () => clock, maxWaitMs: 5000, wait: async ms => { clock += ms; } },
    fetchImpl: async () => { calls++; return json({}, 503); } });
  await assert.rejects(provider.generate(f.generation), error => error.kind === 'SERVICE_TRANSIENT' && error.serviceBudgetExhausted);
  assert.equal(calls, 2);
  await assert.rejects(provider.generate(f.generation), error => error.kind === 'SERVICE_TRANSIENT' && error.serviceBudgetExhausted);
  assert.equal(calls, 2);
  const concept = { spec, project: f.project, taskState: path.join(f.root, 'task'), short: 'frozen', iteration: 1,
    job: {}, imageProvider: { generate: async () => { throw Object.assign(new Error('image_http_502'), { kind: 'SERVICE_TRANSIENT' }); } },
    reportProgress: async () => {}, review: async () => assert.fail('No image is available for review') };
  await assert.rejects(prepareModelingConcept(concept), error => error.kind === 'SERVICE_TRANSIENT');
  assert.equal(await readJson(path.join(f.project, 'art/modeling-concepts/fox/frozen/iteration-1/concept-review.json')), null);
});

test('an explicit content rejection retains safe evidence and is never retried as an outage', async t => {
  const f = await fixture(t); let calls = 0;
  const provider = createModelingImageProvider({ settings: f.settings, credential: f.credential,
    fetchImpl: async () => {
      calls++;
      return new Response(JSON.stringify({ error: { code: 'moderation_blocked', message: 'private-image-key',
        type: 'image_generation_user_error', nested: { auth: 'private-router-auth' } } }),
      { status: 400, headers: { 'x-request-id': '7e3f7fb6-c6d6-4846-a31f-a78955b8b99a' } });
    } });
  for (let resume = 0; resume < 2; resume++) await assert.rejects(provider.generate(f.generation), error =>
    error.kind === 'IMAGE_INPUT_REJECTED' && error.requiresInputChange && error.retrySafe === false &&
    error.responseEvidence.code === 'moderation_blocked');
  assert.equal(calls, 1);
  const retained = await readJson(f.generation.stateFile);
  assert.equal(retained.responseEvidence.requestId, '7e3f7fb6-c6d6-4846-a31f-a78955b8b99a');
  assert.match(retained.responseEvidence.bodySha256, /^[a-f0-9]{64}$/);
  assert.equal(retained.responseEvidence.truncated, false);
  assert.doesNotMatch(JSON.stringify(retained), /private-image-key|private-router-auth|nested|message/);
});

test('untrusted, oversized and authentication responses cannot become a content rejection', async t => {
  for (const [name, status, body] of [
    ['authentication', 401, JSON.stringify({ error: { code: 'moderation_blocked' } })],
    ['unknown', 400, JSON.stringify({ error: { code: 'private-image-key', message: 'moderation_blocked' } })],
    ['oversized', 400, JSON.stringify({ error: { code: 'moderation_blocked', message: 'x'.repeat(17000) } })],
  ]) {
    const f = await fixture(t);
    const provider = createModelingImageProvider({ settings: f.settings, credential: f.credential,
      fetchImpl: async () => new Response(body, { status, headers: { 'x-request-id': 'private-image-key' } }) });
    await assert.rejects(provider.generate(f.generation), error => error.kind === 'SERVICE_CONFIGURATION', name);
    const retained = await readJson(f.generation.stateFile);
    assert.ok(retained.responseEvidence.retainedBytes <= 16384);
    assert.equal(retained.responseEvidence.truncated, name === 'oversized');
    assert.doesNotMatch(JSON.stringify(retained), /private-image-key/);
  }
});

test('content rejection blocks unchanged concept inputs across rounds, without asking for another draft', async t => {
  const f = await fixture(t); let images = 0, reviews = 0;
  const imageProvider = createModelingImageProvider({ settings: f.settings, credential: f.credential,
    fetchImpl: async () => { images++; return json({ error: { code: 'moderation_blocked' } }, 400); } });
  const args = { spec, project: f.project, taskState: path.join(f.root, 'task'), short: 'frozen', iteration: 1,
    job: {}, imageProvider, reportProgress: async () => {}, review: async () => { reviews++; } };
  const first = await prepareModelingConcept(args);
  assert.equal(first.status, 'GAP'); assert.equal(first.issue.kind, 'IMAGE_INPUT_REJECTED');
  assert.equal(first.issue.requiresInputChange, true);
  const next = await prepareModelingConcept({ ...args, iteration: 2 });
  assert.equal(next.issue.kind, 'IMAGE_INPUT_REJECTED'); assert.equal(images, 1); assert.equal(reviews, 0);
  await assert.rejects(retainConceptInputRejection({ ...args, error: { kind: 'SERVICE_CONFIGURATION' } }), /confirmed/);
  const rejected = await readJson(first.evidence.find(row => row.file.includes('rejected-input-')).file);
  assert.ok(rejected.evidence.some(row => row.file.endsWith('draft-1.json')));
  await fs.appendFile(rejected.evidence.find(row => row.file.endsWith('draft-1.json')).file, 'changed');
  await assert.rejects(prepareModelingConcept({ ...args, iteration: 3 }), error => error.kind === 'INTEGRITY_ERROR');
  assert.equal(images, 1);
});

test('truncated concept PNG cannot be published or approved', () => {
  assert.deepEqual(checkConceptPng(png()), { width: 256, height: 256 });
  assert.throws(() => checkConceptPng(png().subarray(0, -4)), /PNG/);
});

test('detailed rigs and complex organic subjects choose image generation; editable reuse still has priority', () => {
  const context = { spec, candidates: [], providerEnabled: true };
  assert.equal(selectModelingRoute(advice(), context).route, 'image_tripo_blender');
  assert.equal(selectModelingRoute(advice(spec, false), { ...context, providerEnabled: false }).route, 'image_tripo_blender');
  const animal = { ...spec, requireRig: false, contract: defaultContract({ assetClass: 'organic-static' }) };
  assert.equal(selectModelingRoute(advice(animal), { ...context, spec: animal }).route, 'image_tripo_blender');
  const modular = { ...spec, requireRig: false, contract: defaultContract({ assetClass: 'modular-kit' }) };
  assert.equal(selectModelingRoute(advice(modular), { ...context, spec: modular }).route, 'blender_direct');
  const reusable = advice(); reusable.candidates = [{ assetId: 'source', similarity: .95, canMeetQuality: true,
    editPlan: ['Repair materials'], qualityByCriterion: reusable.direct.qualityByCriterion, reason: 'Editable close match.' }];
  assert.equal(selectModelingRoute(reusable, { ...context, candidates: [{ assetId: 'source', previewImages: ['front.png'] }] }).route, 'reuse_blender');
});

test('a visual GAP triggers a new image, never another vote; concept approval and resume retain all evidence', async t => {
  const f = await conceptFixture(t, ['GAP', 'PASS']);
  const result = await prepareModelingConcept(f.args);
  assert.equal(result.status, 'APPROVED'); assert.deepEqual(f.events, ['image', 'review', 'image', 'review']);
  assert.notEqual(result.attempts[0].sha256, result.attempts[1].sha256);
  assert.equal((await prepareModelingConcept(f.args)).image.sha256, result.image.sha256);
  assert.equal(f.events.length, 4);
});

test('duplicate rejected pixels cannot obtain a resampled PASS', async t => {
  const f = await conceptFixture(t, ['GAP', 'PASS'], true);
  assert.equal((await prepareModelingConcept(f.args)).status, 'GAP');
  assert.deepEqual(f.events, ['image', 'review', 'image']);
});

test('Tripo uploads only an approved image, uses image-to-model, and reuses a paid task', async t => {
  const f = await conceptFixture(t), concept = await prepareModelingConcept(f.args), calls = [];
  const keyFile = path.join(f.root, 'tripo.txt'); await fs.writeFile(keyFile, 'private-tripo-key');
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/files')) {
      assert.ok(options.body instanceof FormData); assert.equal(options.headers['Content-Type'], undefined);
      assert.equal(options.body.get('file').type, 'image/png'); return json({ code: 0, data: { file_token: 'reviewed_image' } });
    }
    if (url.endsWith('/generation/image-to-model')) {
      const body = JSON.parse(options.body); assert.equal(body.input, 'reviewed_image'); assert.equal(body.prompt, undefined);
      assert.equal(body.texture_quality, 'detailed'); return json({ code: 0, data: { task_id: 'image_task' } });
    }
    if (url.includes('/tasks/')) return json({ code: 0, data: { status: 'success', output: { model_url: 'https://cdn.tripo3d.ai/fox.glb' } } });
    assert.equal(options.headers, undefined); return new Response(glb());
  };
  const provider = createTripoProvider({ keyFile, fetchImpl, pollMs: 1, maxWaitMs: 2000 });
  const args = { project: f.project, directory: 'art/model', stateFile: path.join(f.root, 'tripo.json'), ledgerFile: path.join(f.root, 'ledger.json'),
    assetId: 'fox', requirementsHash: 'frozen', image: { ...concept.image, approval: concept.approval } };
  assert.equal((await provider.generate(args)).status, 'ready');
  assert.equal((await provider.generate(args)).status, 'ready'); assert.equal(calls.length, 4);
  assert.equal(calls.some(call => /text-to|image-generation/.test(call.url)), false);
  const approval = await readJson(path.join(f.project, concept.approval.file));
  await fs.appendFile(path.join(f.project, approval.review.file), 'changed');
  await assert.rejects(provider.generate(args), error => error.kind === 'INTEGRITY_ERROR');
  assert.equal(calls.length, 4);
});

async function pipelineFixture(t, { conceptGap = false, modelGap = false } = {}) {
  const f = await fixture(t), events = []; let images = 0;
  const simple = { ...spec, assetId: 'prop', description: 'Modular prop', prompt: 'Plain cube prop', requireRig: false,
    contract: defaultContract({ assetClass: 'modular-kit' }) };
  const options = { project: f.project, output: f.output, job: { taskId: 'task', workspaceId: 'workspace', runId: 'run', modelingSpecs: [spec, simple] },
    invocation: { command: process.execPath, args: [] }, signal: new AbortController().signal, step: async () => {},
    probe: async () => ({ blenderMcpAvailable: true, blenderVersion: 'fixture' }),
    imageProvider: createModelingImageProvider({ settings: f.settings, credential: f.credential, fetchImpl: async () => {
      events.push('image'); return json({ data: [{ b64_json: png(100 + ++images).toString('base64') }] });
    } }),
    evaluate: async ({ name, prompt }) => {
      if (name === 'modeling-concept-review') { events.push('review'); return verdict(conceptGap ? 'GAP' : 'PASS'); }
      return advice(prompt.includes('"assetId":"prop"') ? simple : spec);
    },
    provider: { availability: async () => ({ enabled: true }), balance: async () => ({ status: 'ready', balance: 100 }),
      generate: async ({ directory, image }) => {
        assert.ok(image.approval); events.push('tripo');
        const modelFile = directory + '/tripo-model.glb'; await fs.mkdir(path.join(f.project, directory), { recursive: true });
        await fs.writeFile(path.join(f.project, modelFile), glb());
        return { status: 'ready', modelFile, sha256: await hashFile(path.join(f.project, modelFile)) };
      } },
    build: async context => {
      events.push('build:' + context.spec.assetId);
      assert.deepEqual(context.spec.requirements, spec.requirements);
      if (context.spec.assetId === 'fox') {
        assert.equal(context.generatedRefinement, true); assert.equal(context.cleanup, false);
        assert.ok(context.sourceFile); assert.ok(context.conceptImage);
      }
      for (const file of ['source.blend', 'model.glb', 'recipe.py', 'asset-manifest.json',
        ...(context.spec.requireRig ? ['model.fbx'] : [])]) await fs.writeFile(path.join(f.project, context.directory, file), 'retained artifact');
      await atomicJson(path.join(f.project, context.directory, 'build-report.json'), { smallEditsOnly: false });
    },
    check: async ({ spec: current }) => {
      const passed = !modelGap || current.assetId !== 'fox';
      return { passed, kind: passed ? null : 'VISUAL_GAP', smallEditsOnly: false,
        feedback: { criteria: current.requirements.map(criterion => ({ criterion, status: passed ? 'PASS' : 'GAP', evidence: 'Actual model view.' })),
          repairInstructions: passed ? '' : 'Repair anatomy and fur.', smallEditsOnly: false } };
    } };
  return { ...f, options, events };
}

test('pipeline runs image-review-Tripo-Blender and preserves rig/animation gates and generated evidence', async t => {
  const f = await pipelineFixture(t), pipeline = createModelingPipeline(f.options);
  const first = await pipeline.prepare();
  assert.equal(first.assets[0].status, 'DCC_READY'); assert.equal(first.assets[0].route, 'image_tripo_blender');
  assert.deepEqual(f.events, ['image', 'review', 'tripo', 'build:fox', 'build:prop']);
  assert.deepEqual(first.assets[0].spec.contract.runtime.animations, ['Walk']);
  await pipeline.verify();
  const prior = f.events.length; await createModelingPipeline(f.options).prepare(); assert.equal(f.events.length, prior);
  await fs.appendFile(path.join(f.project, first.assets[0].generation.concept.image.path), 'mutated');
  await assert.rejects(pipeline.verify(), error => error.kind === 'INTEGRITY_ERROR');
});

test('a content-rejected character does not abort other assets or become a completed character', async t => {
  const f = await pipelineFixture(t); let submissions = 0;
  f.options.imageProvider = createModelingImageProvider({ settings: f.settings, credential: f.credential,
    fetchImpl: async () => { submissions++; return json({ error: { code: 'moderation_blocked' } }, 400); } });
  const pipeline = createModelingPipeline(f.options), first = await pipeline.prepare();
  assert.equal(first.assets[0].status, 'NO_USABLE_ARTIFACT'); assert.equal(first.assets[0].quality.accepted, false);
  assert.equal(first.assets[0].quality.gaps[0].requiresInputChange, true);
  assert.match(first.assets[0].quality.repairInstructions, /do not automatically resubmit/);
  assert.equal(first.assets[1].status, 'DCC_READY');
  assert.equal(f.events.includes('tripo'), false); assert.equal(f.events.includes('build:fox'), false);
  await pipeline.verify();
  await createModelingPipeline(f.options).prepare({ iteration: 2 });
  assert.equal(submissions, 1);
});

test('rejected concepts retain a scored GAP, finish other assets and retry only in a later whole iteration', async t => {
  const f = await pipelineFixture(t, { conceptGap: true });
  const first = await createModelingPipeline(f.options).prepare();
  assert.equal(first.assets[0].status, 'NO_USABLE_ARTIFACT'); assert.equal(first.assets[1].status, 'DCC_READY');
  assert.equal(f.events.includes('tripo'), false); assert.equal(f.events.includes('build:fox'), false);
  assert.deepEqual(f.events, ['image', 'review', 'image', 'review', 'build:prop']);
  await createModelingPipeline(f.options).prepare(); assert.equal(f.events.length, 5);
  await createModelingPipeline(f.options).prepare({ iteration: 2 });
  assert.equal(f.events.filter(event => event === 'image').length, 4);
});

test('deficient models are delivered and the next iteration refines the best Blender source without recharging', async t => {
  const f = await pipelineFixture(t, { modelGap: true });
  const first = await createModelingPipeline(f.options).prepare();
  assert.equal(first.assets[0].status, 'DCC_PROVISIONAL'); assert.equal(first.assets[1].status, 'DCC_READY');
  assert.equal(f.events.filter(event => event === 'build:fox').length, 2);
  let previous = first.assets[0].directory;
  const build = f.options.build;
  f.options.build = async context => {
    if (context.spec.assetId === 'fox') {
      assert.equal(context.sourceFile, 'art/working/fox/source.blend');
      assert.equal(await fs.readFile(path.join(f.project, context.sourceFile), 'utf8'), 'retained artifact');
      assert.equal(context.previousAttemptDirectory, previous);
    }
    await build(context);
    if (context.spec.assetId === 'fox') previous = context.directory;
  };
  const second = await createModelingPipeline(f.options).prepare({ iteration: 2 });
  assert.equal(second.assets[0].status, 'DCC_PROVISIONAL');
  assert.equal(f.events.filter(event => event === 'build:fox').length, 4);
  assert.equal(f.events.filter(event => event === 'image').length, 1);
  assert.equal(f.events.filter(event => event === 'tripo').length, 1);
});

test('a Blender stage failure preserves the generated base for the next whole iteration', async t => {
  const f = await pipelineFixture(t), build = f.options.build;
  f.options.build = async context => {
    if (context.spec.assetId === 'fox') throw new Error('Blender infrastructure unavailable');
    return build(context);
  };
  const first = await createModelingPipeline(f.options).prepare();
  assert.equal(first.assets[0].status, 'NO_USABLE_ARTIFACT');
  assert.equal(first.assets[1].status, 'DCC_READY');
  f.options.build = build;
  const second = await createModelingPipeline(f.options).prepare({ iteration: 2 });
  assert.equal(second.assets[0].status, 'DCC_READY');
  assert.equal(f.events.filter(event => event === 'image').length, 1);
  assert.equal(f.events.filter(event => event === 'tripo').length, 1);
});

for (const failedStage of ['image', 'tripo']) {
  test(failedStage + ' outage retains a stage GAP and completes the other asset without a primitive rebuild', async t => {
    const f = await pipelineFixture(t);
    if (failedStage === 'image') f.options.imageProvider = { generate: async () => ({ status: 'unavailable', reasonCode: 'image_timeout' }) };
    if (failedStage === 'tripo') f.options.provider.generate = async () => ({ status: 'unavailable', reasonCode: 'provider_timeout' });
    const first = await createModelingPipeline(f.options).prepare();
    assert.equal(first.assets[0].status, 'NO_USABLE_ARTIFACT'); assert.equal(first.assets[1].status, 'DCC_READY');
    assert.equal(f.events.includes('build:fox'), false);
    const calls = f.events.length;
    await createModelingPipeline(f.options).prepare(); assert.equal(f.events.length, calls);
  });
}

test('concept review service failure preserves its image and stops without a quality gap or rebuild', async t => {
  const f = await pipelineFixture(t), evaluate = f.options.evaluate;
  f.options.evaluate = async context => {
    if (context.name === 'modeling-concept-review') throw new Error('Review service unavailable');
    return evaluate(context);
  };
  for (let resume = 0; resume < 2; resume++) {
    await assert.rejects(createModelingPipeline(f.options).prepare(), error => error.kind === 'SERVICE_TRANSIENT');
  }
  assert.deepEqual(f.events, ['image']);
});

test('unavailable image router configuration is pinned without globally failing unrelated modeling', async t => {
  const f = await fixture(t), before = process.env.MODELING_IMAGE_BASE_URL;
  t.after(() => { if (before === undefined) delete process.env.MODELING_IMAGE_BASE_URL; else process.env.MODELING_IMAGE_BASE_URL = before; });
  process.env.MODELING_IMAGE_BASE_URL = 'invalid-image-router';
  const identity = await modelingRuntimeIdentity({ command: process.execPath, args: [] }, f.project);
  assert.equal(identity.imageGeneration.unavailable, true);
  assert.doesNotMatch(JSON.stringify(identity), /invalid-image-router/);
});

test('Tripo polling timeout resumes the same paid image task only after the whole iteration', async t => {
  const f = await conceptFixture(t), concept = await prepareModelingConcept(f.args);
  const keyFile = path.join(f.root, 'tripo.txt'); await fs.writeFile(keyFile, 'private-tripo-key');
  let posts = 0, polls = 0, ready = false;
  const fetchImpl = async (url, options) => {
    if (options.method === 'POST') {
      posts++;
      return json({ code: 0, data: url.endsWith('/files') ? { file_token: 'one_image' } : { task_id: 'one_paid_task' } });
    }
    if (url.includes('/tasks/')) {
      polls++;
      return json({ code: 0, data: { status: ready ? 'success' : 'running', output: { model_url: 'https://cdn.tripo3d.ai/model.glb' } } });
    }
    return new Response(glb());
  };
  const args = { project: f.project, directory: 'art/timeout-model', stateFile: path.join(f.root, 'timed-out.json'), ledgerFile: path.join(f.root, 'ledger.json'),
    assetId: 'fox', requirementsHash: 'original', image: { ...concept.image, approval: concept.approval } };
  const provider = createTripoProvider({ keyFile, fetchImpl, pollMs: 1, maxWaitMs: 100 });
  const first = await provider.generate(args);
  assert.equal(first.reasonCode, 'provider_timeout'); assert.equal(first.taskId, 'one_paid_task');
  const count = polls;
  ready = true;
  assert.equal((await provider.generate(args)).status, 'unavailable'); assert.equal(polls, count);
  assert.equal((await provider.generate({ ...args, resumePolling: true })).status, 'ready');
  assert.equal(posts, 2); assert.equal((await readJson(args.ledgerFile)).submissions, 1);
});

for (const revisionId of [undefined, 'revision-a']) test('pipeline carries a timed-out Tripo task across iterations without recharging (' + (revisionId || 'legacy') + ')', async t => {
  const f = await pipelineFixture(t), original = f.options.provider.generate, requests = [];
  f.options.job.revisionId = revisionId;
  f.options.provider.generate = async args => {
    requests.push(args);
    if (requests.length === 1) {
      const failed = { status: 'unavailable', reasonCode: 'provider_timeout', taskId: 'existing_paid_task' };
      await atomicJson(args.stateFile, failed); return failed;
    }
    assert.equal(args.resumePolling, true); assert.equal(args.stateFile, requests[0].stateFile);
    return original(args);
  };
  const pipeline = createModelingPipeline(f.options);
  const first = await pipeline.prepare();
  assert.equal(first.assets[0].status, 'NO_USABLE_ARTIFACT'); assert.equal(first.assets[1].status, 'DCC_READY');
  await pipeline.prepare(); assert.equal(requests.length, 1);
  const next = await pipeline.prepare({ iteration: 2 });
  assert.equal(next.assets[0].status, 'DCC_READY'); assert.equal(requests.length, 2);
  assert.equal(f.events.filter(event => event === 'image').length, 1);
});

test('the same production pipeline rechecks provider availability in the next whole iteration', async t => {
  const f = await pipelineFixture(t); let checks = 0;
  f.options.provider.balance = async () => ++checks === 1 ? { status: 'unavailable', reasonCode: 'service_unavailable' } : { status: 'ready', balance: 100 };
  const pipeline = createModelingPipeline(f.options);
  const first = await pipeline.prepare(); assert.equal(first.assets[0].status, 'NO_USABLE_ARTIFACT');
  await pipeline.prepare(); assert.equal(checks, 1);
  const second = await pipeline.prepare({ iteration: 2 });
  assert.equal(second.assets[0].status, 'DCC_READY'); assert.equal(checks, 2);
});
