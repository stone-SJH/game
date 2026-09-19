import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { classifyIterationFailure, createIterationMonitor, monitorSettings, parseMonitorAdvice } from '../agent/iteration-monitor.mjs';
import { inspectProduction, runProductionHarness } from '../agent/production-harness.mjs';

const success = () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, stopConfirmed: true });
const failed = (message, result = {}) => Object.assign(new Error(message), { result: { ...success(), exitCode: 1, ...result } });
const advice = { action: 'repair-project', category: 'project', reason: 'The default map is missing.', repairInstructions: 'Restore the existing default map reference; preserve gameplay and assets.' };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'iteration-monitor-'));
  const project = path.join(root, 'project'), output = path.join(root, 'run');
  await fs.mkdir(path.join(project, 'plan'), { recursive: true });
  await fs.mkdir(output);
  const env = { CODEX_CMD: process.execPath, CODEX_MAX_ATTEMPTS: '0', CODEX_RETRY_DELAY_MS: '1',
    ITERATION_SAME_FAILURE_LIMIT: '3', ITERATION_FAILURE_LIMIT: '8', ITERATION_MONITOR_TIMEOUT_MS: '60000', ITERATION_MONITOR_MAX_CALLS: '2' };
  const prior = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(async () => {
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(root, { recursive: true, force: true });
  });
  const calls = [], reviews = [], progress = [];
  const step = async (name, command, args, timeout, cwd, accepts, options) => {
    calls.push({ name, command, args, timeout, cwd, options });
    if (name.startsWith('iteration-diagnosis')) await fs.writeFile(args[args.indexOf('-o') + 1], JSON.stringify(advice));
    const result = success();
    assert.ok(!accepts || await accepts(result));
    return result;
  };
  return { project, output, calls, reviews, progress, step,
    job: { taskId: 'task-fixture', runId: 'run-fixture', workspaceId: 'workspace-fixture', objective: 'Repair a game' },
    signal: new AbortController().signal, invocation: { command: process.execPath, args: [] },
    reportProgress: async value => progress.push(value), onReview: async value => reviews.push(value), unreal: 'UnrealEditor-Cmd.exe',
  };
}

test('failure classification distinguishes Help probe, service outage and cleanup warning', () => {
  const outage = failed('production-orchestrator-57 failed', { stdout: 'unexpected status 503 Service Unavailable', stderr: 'WARNING: failed to clean up stale arg0 temp dirs (os error 145)' });
  assert.deepEqual(classifyIterationFailure(outage, 'production-orchestrator'), { category: 'service', action: 'retry' });
  assert.equal(classifyIterationFailure(failed('cleanup warning', { stderr: 'os error 145' }), 'production-orchestrator').category, 'project-or-unknown');
  for (const commandlet of ['Help', 'LoadPackage']) {
    const error = failed('Validation failed', { stdout: `LogInit: Error: ${commandlet}Commandlet looked like a commandlet, but we could not find the class.` });
    assert.equal(classifyIterationFailure(error, 'unreal-project-validation').action, commandlet === 'Help' ? 'replace-validator' : 'stop');
  }
  assert.equal(classifyIterationFailure(failed('usage', { exitCode: 2 }), 'production-orchestrator').action, 'stop');
  assert.equal(classifyIterationFailure(failed('timeout', { timedOut: true }), 'production-orchestrator').action, 'stop');
});

test('first failure uses rules; second uses restricted AI; third stops despite unlimited production retries', async t => {
  const f = await fixture(t), review = createIterationMonitor(f);
  const error = attempt => failed(`unreal-project-validation-${attempt} failed (exit 1):\nMap missing`, { stdout: 'Missing default map' });
  const first = await review({ attempt: 1, stage: 'unreal-project-validation', error: error(1) });
  assert.equal(first.action, 'repair-project');
  assert.equal(f.calls.length, 0);
  const second = await review({ attempt: 2, stage: 'unreal-project-validation', error: error(2) });
  assert.equal(second.aiInvoked, true);
  assert.equal(second.repairInstructions, advice.repairInstructions);
  const { args, timeout, options } = f.calls[0];
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  for (const setting of ['mcp_servers={}', 'features.shell_tool=false', 'features.apps=false', 'features.multi_agent=false',
    'features.hooks=false', 'features.plugins=false', 'project_doc_max_bytes=0', 'features.skip_host_skill_discovery=true']) assert.ok(args.includes(setting), setting);
  assert.equal(timeout, 60000);
  assert.match(options.input, /Tools are disabled/);
  const third = await review({ attempt: 3, stage: 'unreal-project-validation', error: error(3) });
  assert.equal(third.action, 'stop');
  assert.equal(third.occurrences, 3);
  assert.equal(f.calls.length, 1);
  assert.match(f.progress.at(-1).error, /retry limit reached/);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.output, 'iteration-monitor-3.json'), 'utf8')).action, 'stop');
});

test('AI call budget, total failure budget, and successful reviews do not reset one another', async t => {
  const f = await fixture(t), review = createIterationMonitor(f);
  for (let attempt = 1; attempt <= 8; attempt++) {
    const value = await review({ attempt, stage: `stage-${Math.floor((attempt - 1) / 2)}`, error: failed('content invalid') });
    assert.equal(value.action, attempt === 8 ? 'stop' : 'repair-project');
  }
  assert.equal(f.calls.length, 2);
  const pass = await review({ attempt: 9, stage: 'complete' });
  assert.equal(pass.action, 'complete');
  assert.equal(pass.aiInvoked, false);
  assert.equal(pass.aiCalls, 2);
});

test('known outages never invoke AI and stop after the third failure', async t => {
  const f = await fixture(t), review = createIterationMonitor(f);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const record = await review({ attempt, stage: 'production-orchestrator', error: failed('503 Service Unavailable') });
    assert.equal(record.action, attempt < 3 ? 'retry' : 'stop');
  }
  assert.equal(f.calls.length, 0);
});

test('different Unreal content errors are not treated as the same failure', async t => {
  const f = await fixture(t), review = createIterationMonitor(f);
  for (const [index, cause] of ['Missing map', 'Invalid blueprint', 'Missing map'].entries()) {
    const record = await review({ attempt: index + 1, stage: 'unreal-project-validation',
      error: failed(`unreal-project-validation-${index + 1} failed (exit 1)`, { stdout: `[2026.09.19-12.00.0${index}:001][0]LogInit: Error: ${cause}` }) });
    assert.equal(record.occurrences, index === 2 ? 2 : 1);
    assert.notEqual(record.action, 'stop');
  }
  assert.equal(f.calls.length, 1);
});

test('monitor timeout or invalid advice falls back to bounded rules, without recursive diagnosis', async t => {
  const f = await fixture(t);
  f.step = async () => { throw failed('diagnosis timeout', { timedOut: true }); };
  const review = createIterationMonitor(f);
  await review({ attempt: 1, stage: 'deliverables', error: failed('Missing package') });
  const second = await review({ attempt: 2, stage: 'deliverables', error: failed('Missing package') });
  assert.equal(second.action, 'repair-project');
  assert.match(second.monitorError, /timeout/);
  assert.equal((await review({ attempt: 3, stage: 'deliverables', error: failed('Missing package') })).action, 'stop');
  assert.throws(() => parseMonitorAdvice(JSON.stringify({ ...advice, action: 'skip-validation' })), /Invalid/);
  assert.throws(() => parseMonitorAdvice(JSON.stringify({ ...advice, command: 'delete files' })), /Invalid/);
  assert.throws(() => parseMonitorAdvice('{bad'), SyntaxError);
});

test('monitor cannot authorize worker repairs and cannot swallow uncertain process shutdown', async t => {
  const f = await fixture(t);
  f.step = async (name, command, args) => {
    await fs.writeFile(args[args.indexOf('-o') + 1], JSON.stringify({ ...advice, category: 'infrastructure' }));
    return success();
  };
  const review = createIterationMonitor(f);
  await review({ attempt: 1, stage: 'validation', error: failed('harness bug') });
  assert.equal((await review({ attempt: 2, stage: 'validation', error: failed('harness bug') })).action, 'stop');
  const controller = new AbortController();
  const canceled = createIterationMonitor({ ...f, signal: controller.signal, step: async () => { controller.abort(); throw new Error('Canceled'); } });
  await canceled({ attempt: 1, stage: 'validation', error: failed('bug') });
  await assert.rejects(canceled({ attempt: 2, stage: 'validation', error: failed('bug') }), /Canceled/);
  const uncertain = createIterationMonitor({ ...f, step: async () => { throw Object.assign(new Error('Uncertain shutdown'), { stopConfirmed: false }); } });
  await uncertain({ attempt: 1, stage: 'validation', error: failed('bug') });
  await assert.rejects(uncertain({ attempt: 2, stage: 'validation', error: failed('bug') }), error => error.stopConfirmed === false);
});

test('invalid budgets cannot silently disable the monitor; AI can be disabled explicitly', async t => {
  await fixture(t);
  process.env.ITERATION_FAILURE_LIMIT = 'NaN';
  assert.throws(monitorSettings, /ITERATION_FAILURE_LIMIT/);
  process.env.ITERATION_FAILURE_LIMIT = '8';
  process.env.ITERATION_MONITOR_MAX_CALLS = '0';
  assert.equal(monitorSettings().maxCalls, 0);
});

async function seedDeliverables(project) {
  await fs.mkdir(path.join(project, 'package', 'Windows'), { recursive: true });
  await fs.writeFile(path.join(project, 'Game.uproject'), '{}');
  await fs.writeFile(path.join(project, 'scene-preview.png'), 'preview');
  await fs.writeFile(path.join(project, 'package', 'Windows', 'Game.exe'), 'game');
  const plan = JSON.parse(await fs.readFile(path.join(project, 'plan', 'production-plan.json'), 'utf8'));
  const { files } = await inspectProduction(project);
  for (const [role, file] of Object.entries(files)) {
    if (!file.endsWith('.json')) continue;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const value = role === 'stageManifest' ? { stages: plan.stages.map(stage => ({ ...stage, status: 'ACCEPTED' })) }
      : { protocol: 1, passed: true, status: 'PASS', criteria: [{ status: 'PASS' }] };
    await fs.writeFile(file, JSON.stringify(value));
  }
}

test('known invalid Help validation is replaced once on existing deliverables, retaining acceptance gates', async t => {
  const f = await fixture(t), steps = [];
  f.step = async (name, command, args, timeout, cwd, accepts) => {
    steps.push(name);
    if (name.startsWith('production-orchestrator')) await seedDeliverables(f.project);
    if (name === 'unreal-project-validation-1') throw failed('Probe failed', { args: ['-run=Help'], stdout: 'HelpCommandlet looked like a commandlet, but we could not find the class.' });
    if (name === 'unreal-project-validation-repair-1') assert.ok(args.includes('-run=LoadPackage'));
    if (accepts) assert.equal(await accepts(success()), true);
    return success();
  };
  await runProductionHarness({ ...f, onIterationReview: f.onReview });
  assert.deepEqual(steps, ['production-orchestrator-1', 'unreal-project-validation-1', 'unreal-project-validation-repair-1', 'packaged-game-playtest-1']);
  assert.deepEqual(f.reviews.map(value => value.record.action), ['replace-validator', 'complete']);
  const failure = { ...f, step: async (...args) => {
    const result = await f.step(...args);
    if (args[0] === 'packaged-game-playtest-1') {
      const file = path.join(f.project, 'acceptance', 'acceptance-report.json');
      await fs.writeFile(file, JSON.stringify({ protocol: 1, passed: false, criteria: [{ status: 'FAIL' }] }));
    }
    return result;
  } };
  process.env.CODEX_MAX_ATTEMPTS = '1';
  await assert.rejects(runProductionHarness(failure), /Acceptance report does not prove/);
});

test('unavailable LoadPackage stops immediately instead of regenerating the game', async t => {
  const f = await fixture(t);
  let iterations = 0;
  f.step = async name => {
    if (name.startsWith('production-orchestrator')) { iterations++; await seedDeliverables(f.project); }
    if (name.startsWith('unreal-project-validation')) throw failed('Validation failed', { stdout: 'LoadPackageCommandlet looked like a commandlet, but we could not find the class.' });
    return success();
  };
  await assert.rejects(runProductionHarness(f), /Iteration monitor stopped at iteration 1/);
  assert.equal(iterations, 1);
});

test('harness passes failure diagnosis to the next production prompt and stops repeated failures', async t => {
  const f = await fixture(t), prompts = [];
  const originalStep = f.step;
  f.step = async (...args) => {
    if (args[0].startsWith('production-orchestrator')) prompts.push(args[6].input);
    return originalStep(...args);
  };
  await assert.rejects(runProductionHarness(f), /Iteration monitor stopped at iteration 3/);
  assert.equal(prompts.length, 3);
  assert.match(prompts[1], /Production deliverables missing/);
  assert.match(prompts[2], /Restore the existing default map reference/);
  assert.equal(f.calls.filter(call => call.name.startsWith('iteration-diagnosis')).length, 1);
});
