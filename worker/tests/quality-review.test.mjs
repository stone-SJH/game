import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { inspectProduction, runProductionHarness } from '../agent/production-harness.mjs';
import { extractQualityCriteria, parseQualityAdvice, qualityReviewSettings } from '../agent/quality-review.mjs';

const stages = ['intake-and-contract', 'project-bootstrap', 'art-direction-and-asset-plan', 'asset-production-and-import',
  'level-blockout-and-traversal', 'gameplay-foundation-and-input', 'camera-combat-ai-and-feel',
  'world-materials-fx-audio-and-ui', 'integration-build-and-playtest', 'package-and-acceptance'];

function environment(t, values) {
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

test('quality criteria require an explicit marker and the default budget is five', () => {
  const criteria = extractQualityCriteria({ objective: 'Make a platformer.\n质量验收条件：\n- 美术精度达到卡通参考\n- 关卡节奏有休息段\n- 交互手感响应及时' });
  assert.equal(criteria.length, 3);
  assert.equal(extractQualityCriteria({ objective: 'Make a polished platformer.' }).length, 0);
  assert.equal(qualityReviewSettings().maxIterations, 5);
  assert.throws(() => { process.env.QUALITY_REVIEW_MAX_ITERATIONS = '6'; qualityReviewSettings(); }, /QUALITY_REVIEW_MAX_ITERATIONS/);
  delete process.env.QUALITY_REVIEW_MAX_ITERATIONS;
});

test('quality review repairs only a concrete gap and then completes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-review-'));
  const project = path.join(root, 'project'), output = path.join(root, 'run');
  await fs.mkdir(path.join(project, 'plan'), { recursive: true });
  await fs.mkdir(output);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  environment(t, { CODEX_CMD: process.execPath, CODEX_MAX_ATTEMPTS: '0', CODEX_RETRY_DELAY_MS: '1', QUALITY_REVIEW_MAX_ITERATIONS: '5' });
  const calls = [], reviews = [], qualityCalls = { count: 0 };
  const step = async (name, command, args, timeout, cwd, accepts) => {
    calls.push(name);
    if (name.startsWith('production-orchestrator')) await seedDeliverables(project);
    if (name.startsWith('quality-review-')) {
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
    unreal: 'UnrealEditor-Cmd.exe', reportProgress: async () => {}, onIterationReview: async value => reviews.push(value.record) });
  assert.equal(calls.filter(name => name.startsWith('production-orchestrator-')).length, 2);
  assert.equal(qualityCalls.count, 2);
  assert.deepEqual(reviews.map(record => record.action), ['complete', 'repair-project', 'complete', 'complete']);
  assert.equal(JSON.parse(await fs.readFile(path.join(project, 'plan', 'production-context.json'), 'utf8')).qualityReview.maxAdditionalIterations, 5);
  assert.equal(JSON.parse(await fs.readFile(path.join(output, 'quality-review-1.json'), 'utf8')).remainingGap, 0.4);
  assert.equal(JSON.parse(await fs.readFile(path.join(output, 'quality-review-2.json'), 'utf8')).action, 'complete');
});

test('quality advice cannot complete with an unresolved dimension gap', () => {
  const value = qualityAdvice('repair-project');
  value.action = 'complete';
  assert.throws(() => parseQualityAdvice(JSON.stringify(value)), /unresolved gap/);
});

test('quality review stops after its bounded additional-iteration budget', async t => {
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
      advice.recommendedAdditionalIterations = 2;
      await fs.writeFile(args[args.indexOf('-o') + 1], JSON.stringify(advice));
    }
    const result = { exitCode: 0, stdout: '', stderr: '', timedOut: false, stopConfirmed: true };
    assert.ok(!accepts || await accepts(result));
    return result;
  };
  const job = { taskId: 'task-quality', runId: 'run-quality', workspaceId: 'workspace-quality',
    objective: 'Make a platformer.\n质量验收条件：\n- 美术精度达到卡通参考' };
  await assert.rejects(runProductionHarness({ job, project, output, signal: new AbortController().signal, step,
    unreal: 'UnrealEditor-Cmd.exe', reportProgress: async () => {} }), /Quality review budget exhausted/);
  assert.equal(productionCalls, 3);
  assert.equal(qualityCalls, 3);
});
