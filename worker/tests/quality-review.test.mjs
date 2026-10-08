import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { collectQualityEvidence, inspectProduction, runProductionHarness } from '../agent/production-harness.mjs';
import { extractQualityCriteria, parseQualityAdvice, qualityReviewSettings } from '../agent/quality-review.mjs';
import { defaultContract } from '../agent/modeling-contract.mjs';
import { atomicJson, hashValue } from '../agent/modeling-io.mjs';

const stages = ['intake-and-contract', 'project-bootstrap', 'art-direction-and-asset-plan', 'asset-production-and-import',
  'level-blockout-and-traversal', 'gameplay-foundation-and-input', 'camera-combat-ai-and-feel',
  'world-materials-fx-audio-and-ui', 'integration-build-and-playtest', 'package-and-acceptance'];

function environment(t, values) {
  values = { MODELING_ROUTING_ENABLED: '0', ...values }; // Modeling has dedicated route/contract tests.
  const prior = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

async function seedDeliverables(project) {
  await fs.mkdir(path.join(project, 'package', 'Windows'), { recursive: true });
  await fs.writeFile(path.join(project, 'Game.uproject'), '{}');
  await fs.writeFile(path.join(project, 'scene-preview.png'), 'preview');
  await fs.writeFile(path.join(project, 'package', 'Windows', 'Game.exe'), 'game');
  const { files } = await inspectProduction(project);
  for (const [role, file] of Object.entries(files)) {
    if (!file.endsWith('.json')) continue;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const identity = { taskId: 'task-quality', runId: 'run-quality', workspaceId: 'workspace-quality' };
    const value = role === 'stageManifest'
      ? { protocol: 1, ...identity, stages: stages.map(id => ({ id, status: 'ACCEPTED' })) }
      : role === 'acceptanceReport'
        ? { protocol: 1, ...identity, status: 'ACCEPTED', pass: true, accepted: true, passed: true,
          packagedGameStatus: 'PASS', gameplayStatus: 'PASS', visualStatus: 'PASS', criteria: [{ status: 'PASS' }] }
        : role.endsWith('-evidence') ? { protocol: 1, status: 'PASS', criteria: [{ status: 'PASS' }] }
          : { protocol: 1, status: 'ACCEPTED' };
    await fs.writeFile(file, JSON.stringify(value));
  }
}

function dimension(status, summary = 'Evidence reviewed.') {
  return { status, summary, evidence: ['acceptance/acceptance-report.json'], gap: status === 'GAP' ? 'Concrete quality gap remains.' : '' };
}

function qualityAdvice(action) {
  const gap = action === 'repair-project';
  return {
    action, reason: gap ? 'Art precision still trails the explicit target.' : 'All explicit quality criteria are met.',
    criteria: [
      { id: 'quality-1', description: 'Art precision matches the stated target.', status: gap ? 'GAP' : 'PASS', evidence: ['scene-preview.png'], gap: gap ? 'Material and silhouette fidelity need one repair pass.' : '' },
      { id: 'quality-2', description: 'Level pacing has a clear rhythm.', status: 'PASS', evidence: ['acceptance/playtest-evidence.json'], gap: '' },
      { id: 'quality-3', description: 'Interaction feel is responsive.', status: 'PASS', evidence: ['acceptance/playtest-evidence.json'], gap: '' },
    ],
    dimensions: { artPrecision: dimension(gap ? 'GAP' : 'PASS'), levelPacing: dimension('PASS'), interactionFeel: dimension('PASS') },
    repairInstructions: gap ? 'Improve the explicitly requested material and silhouette fidelity, then rerun the hard gates.' : '',
    remainingGap: gap ? 0.4 : 0,
    recommendedAdditionalIterations: gap ? 1 : 0,
  };
}

test('quality criteria preserve explicit markers and plain-language requests', () => {
  const criteria = extractQualityCriteria({ objective: 'Make a platformer.\n质量验收条件：\n- 美术精度达到卡通参考\n- 关卡节奏有休息段\n- 交互手感响应及时' });
  assert.equal(criteria.length, 3);
  assert.equal(extractQualityCriteria({ objective: 'Make a polished platformer.' }).length, 1);
  const natural = extractQualityCriteria({ objective: '场景要一比一复刻。玩家必须能通关。请独立审核操作手感。' });
  assert.equal(natural.length, 3);
  assert.equal(natural[1].description, '玩家必须能通关。');
  assert.equal(qualityReviewSettings().maxIterations, 10);
  assert.equal(qualityReviewSettings().timeoutMs, 1200000);
  assert.throws(() => { process.env.QUALITY_REVIEW_MAX_ITERATIONS = '101'; qualityReviewSettings(); }, /QUALITY_REVIEW_MAX_ITERATIONS/);
  delete process.env.QUALITY_REVIEW_MAX_ITERATIONS;
});

test('quality review repairs only a concrete gap and then completes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-review-'));
  const project = path.join(root, 'project'), output = path.join(root, 'run');
  await fs.mkdir(path.join(project, 'plan'), { recursive: true });
  await fs.mkdir(output);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  environment(t, { CODEX_CMD: process.execPath, CODEX_MAX_ATTEMPTS: '0', CODEX_RETRY_DELAY_MS: '1', QUALITY_REVIEW_MAX_ITERATIONS: '5' });
  const calls = [], reviews = [], progress = [], qualityCalls = { count: 0 };
  const step = async (name, command, args, timeout, cwd, accepts) => {
    calls.push(name);
    if (name.startsWith('production-orchestrator')) await seedDeliverables(project);
    if (name.startsWith('quality-review-')) {
      assert.ok(args.includes('--image'));
      qualityCalls.count++;
      await fs.writeFile(args[args.indexOf('-o') + 1], JSON.stringify(qualityAdvice(qualityCalls.count === 1 ? 'repair-project' : 'complete')));
    }
    const result = { exitCode: 0, stdout: '', stderr: '', timedOut: false, stopConfirmed: true };
    assert.ok(!accepts || await accepts(result));
    return result;
  };
  const job = {
    taskId: 'task-quality', runId: 'run-quality', workspaceId: 'workspace-quality',
    objective: 'Make a platformer.\n质量验收条件：\n- 美术精度达到卡通参考\n- 关卡节奏有休息段\n- 交互手感响应及时',
  };
  await runProductionHarness({ job, project, output, signal: new AbortController().signal, step,
    unreal: 'UnrealEditor-Cmd.exe', reportProgress: async value => progress.push(value), onIterationReview: async value => reviews.push(value.record) });
  assert.equal(calls.filter(name => name.startsWith('production-orchestrator-')).length, 2);
  assert.equal(qualityCalls.count, 2);
  assert.deepEqual(reviews.filter(record => record.kind === 'quality-review').map(record => record.action), ['repair-project', 'complete']);
  assert.deepEqual(reviews.filter(record => record.kind === 'iteration-delivery').map(record => record.score), [67, 100]);
  assert.equal(JSON.parse(await fs.readFile(path.join(project, 'plan', 'production-context.json'), 'utf8')).qualityReview.maxAdditionalIterations, 5);
  assert.equal(JSON.parse(await fs.readFile(path.join(output, 'quality-review-1.json'), 'utf8')).remainingGap, 0.4);
  assert.equal(JSON.parse(await fs.readFile(path.join(output, 'quality-review-2.json'), 'utf8')).action, 'complete');
  assert.equal(progress.at(-1).error, null);
  assert.equal(progress.at(-1).diagnostic, null);
  assert.ok(!progress.some(value => value.error === 'All explicit quality criteria are met.'));
});

for (const [code, message] of [
  ['HTTP_503', 'unexpected status 503 Service Unavailable, url: http://43.106.115.130:8080/v1/responses, request id: test-request'],
  ['STREAM_DISCONNECTED', 'stream disconnected before completion: stream closed before response.completed'],
]) test('quality transport ' + code + ' preserves diagnostics without consuming a quality round', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-upstream-'));
  const project = path.join(root, 'project'), output = path.join(root, 'run');
  await fs.mkdir(project, { recursive: true }); await fs.mkdir(output);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  environment(t, { CODEX_CMD: process.execPath, CODEX_MAX_ATTEMPTS: '2', CODEX_RETRY_DELAY_MS: '1' });
  const progress = [], deliveries = [], calls = [];
  const step = async (name, command, args) => {
    calls.push(name);
    if (name.startsWith('production-orchestrator')) await seedDeliverables(project);
    if (name.startsWith('quality-review-')) {
      throw Object.assign(new Error(name + ' failed'), { result: { exitCode: 1, stopConfirmed: true,
        stdout: JSON.stringify({ type: 'turn.failed', error: { message } }), stderr: 'stale arg0 temp dirs, error 145' } });
    }
    return { exitCode: 0, stopConfirmed: true };
  };
  await assert.rejects(runProductionHarness({ job: { taskId: 'task-quality', runId: 'run-quality', workspaceId: 'workspace-quality',
      objective: 'Make a polished game.' }, project, output, signal: new AbortController().signal, step, unreal: 'fixture',
    reportProgress: async value => progress.push(value),
    onIterationReview: async ({ record }) => { if (record.kind === 'iteration-delivery') deliveries.push(record); } }),
    error => error.kind === 'SERVICE_TRANSIENT' && error.upstreamAI.code === code);
  assert.equal(deliveries.length, 0);
  assert.equal(calls.filter(name => name.startsWith('quality-review-')).length, 1);
  assert.equal(progress.at(-1).diagnostic.code, code);
  assert.doesNotMatch(progress.at(-1).error, /arg0|145/);
  assert.equal(await fs.readFile(path.join(project, 'package/Windows/Game.exe'), 'utf8'), 'game');
  assert.equal((await fs.readdir(output)).some(name => name.endsWith('-quality-review-gap.json')), false);
});

test('local quality response errors remain distinguishable from upstream outages', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-local-error-'));
  const project = path.join(root, 'project'), output = path.join(root, 'run');
  await fs.mkdir(project, { recursive: true }); await fs.mkdir(output);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  environment(t, { CODEX_CMD: process.execPath, CODEX_MAX_ATTEMPTS: '1' });
  const step = async (name, command, args) => {
    if (name.startsWith('production-orchestrator')) await seedDeliverables(project);
    if (name.startsWith('quality-review-')) await fs.writeFile(args[args.indexOf('-o') + 1], 'invalid JSON');
    return { exitCode: 0, stopConfirmed: true };
  };
  const delivered = await runProductionHarness({ job: { taskId: 'task-quality', runId: 'run-quality', workspaceId: 'workspace-quality',
    objective: 'Make a polished game.' }, project, output, signal: new AbortController().signal, step, unreal: 'fixture' });
  assert.match(delivered.delivery.quality.reason, /Invalid quality reviewer JSON/);
  assert.equal(delivered.delivery.quality.upstreamAI, undefined);
});

test('quality advice cannot complete with an unresolved dimension gap', () => {
  const value = qualityAdvice('repair-project');
  value.action = 'complete';
  assert.throws(() => parseQualityAdvice(JSON.stringify(value)), /unresolved gap/);
});

test('unchanged provisional packages stop with retained deliveries and an explicit no-progress failure', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-review-budget-'));
  const project = path.join(root, 'project'), output = path.join(root, 'run');
  await fs.mkdir(path.join(project, 'plan'), { recursive: true });
  await fs.mkdir(output);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  environment(t, { CODEX_CMD: process.execPath, CODEX_MAX_ATTEMPTS: '0', CODEX_RETRY_DELAY_MS: '1', QUALITY_REVIEW_MAX_ITERATIONS: '2' });
  let productionCalls = 0, qualityCalls = 0;
  const step = async (name, command, args, timeout, cwd, accepts) => {
    if (name.startsWith('production-orchestrator')) { productionCalls++; await seedDeliverables(project); }
    if (name.startsWith('quality-review-')) {
      qualityCalls++;
      const advice = qualityAdvice('repair-project');
      advice.criteria = advice.criteria.slice(0, 1);
      advice.recommendedAdditionalIterations = 2;
      await fs.writeFile(args[args.indexOf('-o') + 1], JSON.stringify(advice));
    }
    const result = { exitCode: 0, stdout: '', stderr: '', timedOut: false, stopConfirmed: true };
    assert.ok(!accepts || await accepts(result));
    return result;
  };
  const job = { taskId: 'task-quality', runId: 'run-quality', workspaceId: 'workspace-quality',
    objective: 'Make a platformer.\n质量验收条件：\n- 美术精度达到卡通参考' };
  const deliveries = [];
  await assert.rejects(runProductionHarness({ job, project, output, signal: new AbortController().signal, step,
    unreal: 'UnrealEditor-Cmd.exe', reportProgress: async () => {},
    onIterationReview: async ({ record }) => { if (record.kind === 'iteration-delivery') deliveries.push(record); } }),
  error => error.kind === 'PRODUCTION_STALLED' && error.productionIncomplete);
  const delivered = { qualityAccepted: deliveries.at(-1).qualityAccepted, delivery: deliveries.at(-1) };
  assert.equal(delivered.qualityAccepted, false);
  assert.equal(delivered.delivery.status, 'DELIVERED_WITH_GAPS');
  assert.equal(await fs.readFile(path.join(project, 'package/Windows/Game.exe'), 'utf8'), 'game');
  assert.equal(JSON.parse(await fs.readFile(path.join(output, 'production-stalled.json'), 'utf8')).kind, 'PRODUCTION_STALLED');
  assert.equal(productionCalls, 3);
  assert.equal(qualityCalls, 3);
});

test('quality review rejects omitted, duplicate, skipped or unsupported criteria', () => {
  const expected = qualityAdvice('complete').criteria;
  for (const mutate of [
    advice => advice.criteria.pop(),
    advice => { advice.criteria[1].id = advice.criteria[0].id; },
    advice => { advice.criteria[0].status = 'NOT_APPLICABLE'; },
    advice => { advice.criteria[0].evidence = []; },
    advice => { advice.dimensions.artPrecision.evidence = ['   ']; },
  ]) {
    const advice = qualityAdvice('complete');
    mutate(advice);
    assert.throws(() => parseQualityAdvice(JSON.stringify(advice), expected));
  }
  assert.deepEqual(extractQualityCriteria({ qualityCriteria: ['  ', 'A', '', 'B'] }).map(row => row.id), ['quality-1', 'quality-2']);
});

for (const productionFails of [false, true]) test('content refusal publishes actionable input and stops after the current round (production fails=' + productionFails + ')', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'input-feedback-harness-'));
  const project = path.join(root, 'project'), output = path.join(root, 'run');
  await fs.mkdir(project); await fs.mkdir(output); t.after(() => fs.rm(root, { recursive: true, force: true }));
  environment(t, { CODEX_CMD: process.execPath, CODEX_MAX_ATTEMPTS: '5', CODEX_RETRY_DELAY_MS: '1',
    MODELING_ROUTING_ENABLED: '1', TRIPO_API_KEY_FILE: path.join(root, 'absent-key') });
  const spec = { assetId: 'stone-statue', description: 'Statue', prompt: 'One stone statue', requirements: ['Stone surface'],
    referenceImages: [], maxTriangles: 10000, requireRig: false, requireClosedMesh: false };
  const job = { taskId: 'task-quality', runId: 'run-quality', workspaceId: 'workspace-quality', objective: 'Make a playable game', modelingSpecs: [spec] };
  const taskState = path.join(root, 'modeling-state/tasks', hashValue({ taskId: job.taskId, workspaceId: job.workspaceId }));
  await atomicJson(path.join(taskState, 'capabilities-1.json'), { blenderMcpAvailable: true });
  await atomicJson(path.join(taskState, 'asset-gap-1-' + hashValue(spec) + '.json'), { assetId: spec.assetId,
    status: 'NO_USABLE_ARTIFACT', usable: false, files: [], spec, quality: { accepted: false, score: 0,
      gaps: [{ stage: 'modeling-concept', kind: 'IMAGE_INPUT_REJECTED', requiresInputChange: true, reason: 'Content review rejected the input',
        inputReview: { provider: 'concept-image', prompt: 'One stone statue', response: { httpStatus: 400, code: 'moderation_blocked', requestId: 'req_fixture' } } }] } });
  const publications = []; let productions = 0;
  await assert.rejects(runProductionHarness({ job, project, output, signal: new AbortController().signal, unreal: 'unused',
    reportProgress: async () => {}, onIterationReview: async record => publications.push(record),
    step: async (name, command, args) => {
      if (name.startsWith('production-orchestrator')) {
        productions++;
        if (productionFails) throw new Error('Fixture packaging failure');
        await seedDeliverables(project);
      }
      return { exitCode: 0, stdout: '', stderr: '', stopConfirmed: true, timedOut: false };
    } }), error => error.kind === 'GENERATION_INPUT_REQUIRED' && error.productionIncomplete);
  assert.equal(productions, 1);
  const feedback = publications.find(item => item.record.kind === 'generation-input-required');
  assert.ok(feedback); assert.equal(feedback.record.blockedAssets[0].issues[0].input.prompt, 'One stone statue');
  assert.equal(JSON.parse(await fs.readFile(feedback.file, 'utf8')).status, 'NEEDS_INPUT_REVISION');
  assert.equal(await fs.stat(path.join(output, 'codex-production-attempt-2.json')).catch(() => null), null);
});

test('large asset plans cannot crowd out the actual scene image from quality review', async t => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-images-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  await fs.mkdir(path.join(project, 'plan'));
  for (let i = 0; i < 60; i++) await fs.writeFile(path.join(project, 'plan', `${i}.json`), JSON.stringify({ output: 'x'.repeat(16000) }));
  await fs.writeFile(path.join(project, 'scene-preview.png'), 'image');
  const evidence = await collectQualityEvidence(project);
  assert.equal(evidence[0].path, 'scene-preview.png');
  assert.equal(evidence[0].type, 'image');
});

test('natural language repairs stage proof after first-launch trust registration without replanning', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engineering-production-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), output = path.join(root, 'run');
  const codexConfig = path.join(root, 'codex-config');
  await fs.mkdir(codexConfig);
  await fs.writeFile(path.join(codexConfig, 'config.toml'), 'model = "fixture"\n');
  environment(t, { MODELING_ROUTING_ENABLED: '1', MODELING_HARNESS_V2_ENABLED: '1', CODEX_CMD: process.execPath,
    CODEX_MAX_ATTEMPTS: '2', CODEX_RETRY_DELAY_MS: '1', CODEX_HOME: codexConfig });
  const job = { taskId: 'task-quality', runId: 'run-quality', workspaceId: 'workspace-quality', objective: 'Repair existing input code.' };
  const calls = [];
  const step = async (name, command, args, timeout, cwd, accepts, options) => {
    calls.push(name);
    if (name.startsWith('modeling-plan')) await fs.writeFile(args[args.indexOf('-o') + 1], JSON.stringify({ reason: 'Existing code only.', assets: [] }));
    if (name.startsWith('modeling-engineering')) await fs.writeFile(args[args.indexOf('-o') + 1], JSON.stringify({
      reason: 'Retain input repair.', playerCapsule: null, playerDecision: 'Existing controller unchanged.', assets: [],
      requirements: [{ id: 'requirement-1', owner: 'gameplay', implementation: 'Repair the input.', verification: 'Exercise input in the packaged game.' }],
      references: [], sources: [], unresolvedFacts: [],
    }));
    if (name.startsWith('production-orchestrator')) {
      assert.match(options.input, /engineering-plan.json/);
      assert.match(options.input, /playerMetrics/);
      assert.match(options.input, /checks:\[\{id,status:"PASS" or "GAP",evidence:/);
      await seedDeliverables(project);
      const file = path.join(project, 'acceptance/acceptance-report.json');
      const acceptance = JSON.parse(await fs.readFile(file, 'utf8'));
      acceptance.criteria = [{ id: 'requirement-1', status: 'PASS', evidence: ['acceptance/playtest-evidence.json'] }];
      await fs.writeFile(file, JSON.stringify(acceptance));
      if (name.endsWith('-1')) {
        await fs.appendFile(path.join(codexConfig, 'config.toml'), `\n[projects.'${project}']\ntrust_level = "trusted"\n`);
        await fs.writeFile(path.join(project, 'stages/intake-and-contract/evidence.json'), JSON.stringify({
          protocol: 1, status: 'PASS', files: [], validation: ['Claims without structured proof must fail.'],
        }));
      } else assert.match(options.input, /passing proof missing/);
    }
    const result = { exitCode: 0, stdout: '', stderr: '', timedOut: false, stopConfirmed: true };
    assert.ok(!accepts || await accepts(result)); return result;
  };
  await runProductionHarness({ job, project, output, signal: new AbortController().signal, step, unreal: 'test-engine' });
  assert.ok(calls[0].startsWith('modeling-plan'));
  assert.ok(calls[1].startsWith('modeling-engineering'));
  assert.ok(calls.some(name => name.startsWith('packaged-game-playtest')));
  assert.equal(calls.filter(name => name.startsWith('modeling-plan')).length, 1);
  assert.equal(calls.filter(name => name.startsWith('modeling-engineering')).length, 1);
  assert.equal(calls.filter(name => name.startsWith('production-orchestrator')).length, 2);
});

test('planning exhaustion completes two playable rounds and delivers retained gaps without restarting same-round calls', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-production-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), output = path.join(root, 'run');
  environment(t, { MODELING_ROUTING_ENABLED: '1', MODELING_HARNESS_V2_ENABLED: '1', CODEX_CMD: process.execPath,
    CODEX_MAX_ATTEMPTS: '0', CODEX_RETRY_DELAY_MS: '1', QUALITY_REVIEW_MAX_ITERATIONS: '1', MODELING_INTAKE_MAX_CALLS: '4' });
  const job = { taskId: 'task-quality', runId: 'run-quality', workspaceId: 'workspace-quality', objective: 'Build a traversable room.' };
  const contract = defaultContract({ traversal: null, pivot: { mode: 'base-center', meters: null, toleranceMeters: .01 },
    runtime: { engine: 'unreal', profile: 'fbx-static', collision: 'convex', lodTriangles: [500], sockets: [], animations: [], lightmapUV: false } });
  const draft = { reason: 'Room required.', assets: [{ assetId: 'room', description: 'Traversable room', prompt: 'Build a room',
    requirements: ['Keep player passage clear.'], maxTriangles: 1000, requireClosedMesh: true, requireRig: false, referenceImages: [], contract }] };
  const calls = [], deliveries = [];
  const step = async (name, command, args, timeout, cwd, accepts, options) => {
    calls.push(name);
    if (name.startsWith('modeling-plan')) await fs.writeFile(args[args.indexOf('-o') + 1], JSON.stringify(draft));
    else if (name.startsWith('modeling-engineering')) await fs.writeFile(args[args.indexOf('-o') + 1], JSON.stringify({
      reason: 'Incomplete engineering response.', playerCapsule: null, playerDecision: 'Unresolved.',
      assets: [{ assetId: 'room', needsTraversal: true, contract, designDecisions: [] }],
      requirements: [{ id: 'requirement-1', owner: 'layout', implementation: 'Make a playable room.', verification: 'Playtest it.' }],
      references: [], sources: [], unresolvedFacts: [],
    }));
    else if (name.startsWith('production-orchestrator')) {
      assert.match(options.input, /PLANNING_PROVISIONAL/);
      assert.match(options.input, /temporary engine-native representations/);
      assert.doesNotMatch(options.input, /write a full replacement plan\/modeling-request/);
      await seedDeliverables(project);
    } else if (!name.startsWith('unreal-project-validation') && !name.startsWith('packaged-game-playtest')) {
      throw new Error(`Unexpected operation: ${name}`);
    }
    return { exitCode: 0, stdout: '', stderr: '', stopConfirmed: true };
  };
  const options = { job, project, output, signal: new AbortController().signal, step, unreal: 'test-engine',
    onIterationReview: async ({ record }) => { if (record.kind === 'iteration-delivery') deliveries.push(record); } };
  const result = await runProductionHarness(options);
  assert.equal(result.qualityAccepted, false);
  assert.equal(result.delivery.status, 'DELIVERED_WITH_GAPS');
  assert.equal(deliveries.length, 2);
  assert.ok(deliveries.every(row => row.score === 0 && row.issues.some(issue => issue.stage === 'modeling-planning')));
  assert.equal(calls.filter(name => name.startsWith('modeling-plan')).length, 1);
  assert.equal(calls.filter(name => name.startsWith('modeling-engineering')).length, 8);
  assert.equal(calls.filter(name => name.startsWith('packaged-game-playtest')).length, 1);
  assert.equal(await fs.readFile(result.files.packageFile, 'utf8'), 'game');
  const manifest = JSON.parse(await fs.readFile(result.delivery.snapshotManifest, 'utf8'));
  const row = manifest.files.find(row => row.path === 'plan/modeling-planning/iteration-1/gap.json');
  const retainedGap = JSON.parse(await fs.readFile(path.join(path.dirname(project), 'storage-v2/objects', row.sha256.slice(0, 2), row.sha256), 'utf8'));
  assert.deepEqual(retainedGap.draft, draft);
  const callCount = calls.length;
  const resumed = await runProductionHarness(options);
  assert.equal(resumed.delivery.score, 0);
  assert.equal(calls.length, callCount);
});
