import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createModelingPipeline } from '../agent/modeling-pipeline.mjs';
import { createModelingReviewer } from '../agent/modeling-review.mjs';
import { createExecutionStore } from '../agent/modeling-execution.mjs';
import { createIterationMonitor } from '../agent/iteration-monitor.mjs';
import { defaultContract } from '../agent/modeling-contract.mjs';
import { atomicJson, hashValue, readJson } from '../agent/modeling-io.mjs';

const plan = { reason: 'Retain every independently reviewable asset and its technical contract.',
  assets: Array.from({ length: 16 }, (_, i) => ({ assetId: `prop-${i}`, description: `Red prop ${i}`,
    prompt: `Red prop ${i}`, requirements: [`Prop ${i} has a red body.`], referenceImages: [], maxTriangles: 1000,
    requireRig: false, requireClosedMesh: true, contract: defaultContract({ traversal: null }) })) };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modeling-intake-'));
  const project = path.join(root, 'project'), output = path.join(root, 'run');
  await fs.mkdir(path.join(project, 'plan'), { recursive: true });
  await fs.mkdir(output);
  const env = { MODELING_HARNESS_V2_ENABLED: '1', MODELING_INTAKE_TIMEOUT_MS: undefined, MODELING_EVALUATION_TIMEOUT_MS: undefined };
  const prior = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  t.after(async () => {
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(root, { recursive: true, force: true });
  });
  const job = { taskId: 'task', workspaceId: 'workspace', runId: 'run', objective: 'Create sixteen red props.' };
  const state = path.join(root, 'modeling-state', 'tasks', hashValue({ taskId: job.taskId, workspaceId: job.workspaceId }));
  const intakeComplete = new Error('Intake complete; this test stops before authoring.');
  const abort = new AbortController();
  const calls = [];
  const options = { project, output, job, signal: abort.signal, invocation: { command: process.execPath, args: [] },
    probe: async () => { throw intakeComplete; },
    step: async (name, command, args, timeoutMs) => {
      calls.push({ name, timeoutMs });
      await atomicJson(args[args.indexOf('-o') + 1], plan);
    } };
  return { root, project, output, state, options, calls, intakeComplete, abort };
}

test('multi-asset intake gets twenty minutes and retains every V2 contract', async t => {
  const f = await fixture(t);
  await assert.rejects(createModelingPipeline(f.options).prepare(), error => error === f.intakeComplete);
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].timeoutMs > 1190000 && f.calls[0].timeoutMs <= 1200000);
  assert.deepEqual(await readJson(path.join(f.project, 'plan/modeling-specs.json')), plan);
  const group = Object.values((await readJson(path.join(f.state, 'execution.json'))).groups)[0];
  assert.deepEqual(group.limits, { maxCalls: 2, timeoutMs: 1200000, totalMs: 2400000 });
  assert.equal(group.completed, true);
});

test('intake timeout can be configured independently and is capped by the task deadline', async t => {
  const f = await fixture(t);
  process.env.MODELING_INTAKE_TIMEOUT_MS = '300000';
  process.env.MODELING_EVALUATION_TIMEOUT_MS = '150000';
  f.options.job.deadlineAt = new Date(Date.now() + 45000).toISOString();
  await assert.rejects(createModelingPipeline(f.options).prepare(), error => error === f.intakeComplete);
  assert.ok(f.calls[0].timeoutMs > 0 && f.calls[0].timeoutMs <= 45000);
  const group = Object.values((await readJson(path.join(f.state, 'execution.json'))).groups)[0];
  assert.deepEqual(group.limits, { maxCalls: 2, timeoutMs: 300000, totalMs: 600000 });
  assert.equal(group.deadlineAt, Date.parse(f.options.job.deadlineAt));
});

test('ordinary reviews keep their two-minute timeout', async t => {
  const f = await fixture(t);
  const review = createModelingReviewer({ ...f.options, execution: createExecutionStore(f.state),
    step: async (name, command, args, timeoutMs) => {
      f.calls.push({ name, timeoutMs });
      await atomicJson(args[args.indexOf('-o') + 1], { passed: true });
    } });
  await review({ name: 'modeling-visual', prompt: 'Review the supplied evidence.',
    schema: { type: 'object', additionalProperties: false, properties: { passed: { type: 'boolean' } }, required: ['passed'] } });
  assert.ok(f.calls[0].timeoutMs > 119000 && f.calls[0].timeoutMs <= 120000);
});

test('exhausted intake retains timeout diagnostics, stops the monitor and cannot reset on resume', async t => {
  const f = await fixture(t);
  f.options.step = async (name, command, args, timeoutMs) => {
    f.calls.push({ name, timeoutMs });
    throw Object.assign(new Error(`${name} timed out. ${'Verbose command diagnostics. '.repeat(200)}`),
      { result: { exitCode: 1, timedOut: true, stopConfirmed: true } });
  };
  let failure;
  const verifyFailure = error => {
    failure = error;
    assert.equal(error.kind, 'VALIDATION_INFRASTRUCTURE_EXHAUSTED');
    assert.equal(error.hardFailure, true);
    assert.equal(error.lastFailure.kind, 'REVIEW_TIMEOUT');
    assert.equal(error.lastFailure.timedOut, true);
    assert.equal(error.lastFailure.stopConfirmed, true);
    assert.equal(error.executionFile, path.join(f.state, 'execution.json'));
    assert.match(error.message, /REVIEW_TIMEOUT/);
    assert.ok(error.message.includes(error.executionFile));
    return true;
  };
  await assert.rejects(createModelingPipeline(f.options).prepare(), verifyFailure);
  await assert.rejects(createModelingPipeline(f.options).prepare(), verifyFailure);
  assert.equal(f.calls.length, 2);
  assert.equal(await readJson(path.join(f.state, 'plan.json')), null);
  assert.equal(await readJson(path.join(f.project, 'plan/modeling-specs.json')), null);
  const before = await fs.readFile(failure.executionFile, 'utf8');
  process.env.MODELING_INTAKE_TIMEOUT_MS = '1300000';
  await assert.rejects(createModelingPipeline(f.options).prepare(), error => error.kind === 'INTEGRITY_ERROR');
  assert.equal(f.calls.length, 2);
  assert.equal(await fs.readFile(failure.executionFile, 'utf8'), before);
  const monitor = createIterationMonitor({ ...f.options, reportProgress: async () => {} });
  const result = await monitor({ attempt: 1, stage: 'modeling-assets', error: failure });
  assert.equal(result.action, 'stop');
  assert.equal(result.aiInvoked, false);
  assert.match(result.reason, /REVIEW_TIMEOUT/);
  assert.ok(result.reason.includes(failure.executionFile));
});

test('V2 intake still rejects missing contracts and records schema failures', async t => {
  const f = await fixture(t);
  f.options.evaluate = async () => { f.calls.push('review'); return { ...plan, assets: plan.assets.map(({ contract, ...asset }) => asset) }; };
  await assert.rejects(createModelingPipeline(f.options).prepare(), error => {
    assert.equal(error.lastFailure.kind, 'REVIEW_SCHEMA_INVALID');
    assert.match(error.message, /REVIEW_SCHEMA_INVALID/);
    return true;
  });
  assert.equal(f.calls.length, 2);
  assert.equal(await readJson(path.join(f.state, 'plan.json')), null);
});

test('missing traversal specifications remain a distinct non-retryable contract failure', async t => {
  const f = await fixture(t);
  f.options.evaluate = async () => {
    f.calls.push('review');
    return { reason: 'Player capsule and asset-local paths were not supplied.',
      assets: [{ ...plan.assets[0], description: 'A traversable doorway' }] };
  };
  await assert.rejects(createModelingPipeline(f.options).prepare(), error => {
    assert.equal(error.kind, 'CONTRACT_INCOMPLETE');
    assert.doesNotMatch(error.message, /intake unavailable/);
    return true;
  });
  assert.equal(f.calls.length, 1);
  assert.equal(await readJson(path.join(f.state, 'plan.json')), null);
});

test('unconfirmed process shutdown never retries intake, even after cancellation', async t => {
  const f = await fixture(t);
  f.options.step = async () => {
    f.calls.push('unconfirmed');
    throw Object.assign(new Error('Process stop not confirmed'), { stopConfirmed: false });
  };
  await assert.rejects(createModelingPipeline(f.options).prepare(), error => error.stopConfirmed === false);
  assert.equal(f.calls.length, 1);
  await assert.rejects(createModelingPipeline(f.options).prepare(), error => error.kind === 'STOP_UNCONFIRMED');
  assert.equal(f.calls.length, 1);
  f.abort.abort(new Error('Operator canceled'));
  await assert.rejects(createModelingPipeline(f.options).prepare(), error => error.kind === 'STOP_UNCONFIRMED');
  assert.equal(f.calls.length, 1);
});

test('cancellation with confirmed shutdown never retries intake', async t => {
  const f = await fixture(t);
  f.options.step = async () => {
    f.calls.push('canceled');
    f.abort.abort(new Error('Operator canceled'));
    throw Object.assign(new Error('Stopped'), { result: { canceled: true, stopConfirmed: true } });
  };
  await assert.rejects(createModelingPipeline(f.options).prepare(), /Operator canceled/);
  await assert.rejects(createModelingPipeline(f.options).prepare(), /Operator canceled/);
  assert.equal(f.calls.length, 1);
});
