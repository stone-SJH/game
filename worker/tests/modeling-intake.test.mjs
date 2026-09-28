import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createModelingPipeline } from '../agent/modeling-pipeline.mjs';
import { createModelingReviewer } from '../agent/modeling-review.mjs';
import { createExecutionStore } from '../agent/modeling-execution.mjs';
import { defaultContract } from '../agent/modeling-contract.mjs';
import { atomicJson, hashValue, readJson } from '../agent/modeling-io.mjs';
import { objectiveRequirements } from '../agent/modeling-engineering.mjs';

const plan = { reason: 'Retain every independently reviewable asset and its technical contract.',
  assets: Array.from({ length: 16 }, (_, i) => ({ assetId: `prop-${i}`, description: `Red prop ${i}`,
    prompt: `Red prop ${i}`, requirements: [`Prop ${i} has a red body.`], referenceImages: [], maxTriangles: 1000,
    requireRig: false, requireClosedMesh: true, contract: defaultContract({ traversal: null }) })) };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modeling-intake-'));
  const project = path.join(root, 'project'), output = path.join(root, 'run');
  await fs.mkdir(path.join(project, 'plan'), { recursive: true });
  await fs.mkdir(output);
  const env = { MODELING_HARNESS_V2_ENABLED: '1', MODELING_INTAKE_TIMEOUT_MS: undefined, MODELING_INTAKE_MAX_CALLS: undefined, MODELING_EVALUATION_TIMEOUT_MS: undefined };
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
      await atomicJson(args[args.indexOf('-o') + 1], name.startsWith('modeling-engineering') ? {
        reason: 'The props have no player passage requirement.', playerCapsule: null, playerDecision: 'No player requested.',
        assets: plan.assets.map(asset => ({ assetId: asset.assetId, needsTraversal: false, contract: asset.contract, designDecisions: [] })),
        requirements: objectiveRequirements(job.objective).map(item => ({ id: item.id, owner: 'modeling', implementation: 'Author all sixteen props.', verification: 'Inspect all sixteen outputs.' })),
        references: [], sources: [], unresolvedFacts: [],
      } : plan);
    } };
  return { root, project, output, state, options, calls, intakeComplete, abort };
}

test('multi-asset intake gets twenty minutes and retains every V2 contract', async t => {
  const f = await fixture(t);
  const result = await createModelingPipeline(f.options).prepare();
  assert.equal(result.assets.length, 16);
  assert.ok(result.assets.every(asset => asset.status === 'NO_USABLE_ARTIFACT'));
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[0].timeoutMs > 1190000 && f.calls[0].timeoutMs <= 1200000);
  assert.deepEqual(await readJson(path.join(f.project, 'plan/modeling-specs.json')), plan);
  const group = Object.values((await readJson(path.join(f.state, 'execution.json'))).groups)[0];
  assert.deepEqual(group.limits, { maxCalls: 4, timeoutMs: 1200000, totalMs: 4800000 });
  assert.equal(group.completed, true);
});

test('intake timeout can be configured independently and is capped by the task deadline', async t => {
  const f = await fixture(t);
  process.env.MODELING_INTAKE_TIMEOUT_MS = '300000';
  process.env.MODELING_EVALUATION_TIMEOUT_MS = '150000';
  f.options.job.deadlineAt = new Date(Date.now() + 45000).toISOString();
  assert.equal((await createModelingPipeline(f.options).prepare()).status, 'ASSETS_PROVISIONAL');
  assert.ok(f.calls[0].timeoutMs > 0 && f.calls[0].timeoutMs <= 45000);
  const group = Object.values((await readJson(path.join(f.state, 'execution.json'))).groups)[0];
  assert.deepEqual(group.limits, { maxCalls: 4, timeoutMs: 300000, totalMs: 1200000 });
  assert.equal(group.deadlineAt, Date.parse(f.options.job.deadlineAt));
});

test('ordinary reviews allow the default twenty-minute timeout', async t => {
  const f = await fixture(t);
  const review = createModelingReviewer({ ...f.options, execution: createExecutionStore(f.state),
    step: async (name, command, args, timeoutMs) => {
      f.calls.push({ name, timeoutMs });
      await atomicJson(args[args.indexOf('-o') + 1], { passed: true });
    } });
  await review({ name: 'modeling-visual', prompt: 'Review the supplied evidence.',
    schema: { type: 'object', additionalProperties: false, properties: { passed: { type: 'boolean' } }, required: ['passed'] } });
  assert.ok(f.calls[0].timeoutMs > 1199000 && f.calls[0].timeoutMs <= 1200000);
});

test('exhausted intake retains a provisional handoff and cannot reset on same-round resume', async t => {
  const f = await fixture(t);
  f.options.step = async (name, command, args, timeoutMs) => {
    f.calls.push({ name, timeoutMs });
    throw Object.assign(new Error(`${name} timed out. ${'Verbose command diagnostics. '.repeat(200)}`),
      { result: { exitCode: 1, timedOut: true, stopConfirmed: true } });
  };
  const first = await createModelingPipeline(f.options).prepare();
  assert.equal(first.status, 'PLANNING_PROVISIONAL');
  assert.equal(first.planning.lastFailure.kind, 'REVIEW_TIMEOUT');
  assert.equal(first.planning.lastFailure.stopConfirmed, true);
  assert.equal(first.planning.score, 0);
  assert.equal(first.planning.objective, f.options.job.objective);
  const resumed = createModelingPipeline(f.options);
  assert.deepEqual((await resumed.prepare()).planning, first.planning);
  await resumed.verify();
  assert.equal(f.calls.length, 4);
  assert.equal(await readJson(path.join(f.state, 'plan.json')), null);
  assert.equal(await readJson(path.join(f.project, 'plan/modeling-specs.json')), null);
  const executionFile = path.join(f.state, 'execution.json');
  const before = await fs.readFile(executionFile, 'utf8');
  process.env.MODELING_INTAKE_TIMEOUT_MS = '1300000';
  await assert.rejects(createModelingPipeline(f.options).prepare(), /toolchain changed/);
  assert.equal(f.calls.length, 4);
  assert.equal(await fs.readFile(executionFile, 'utf8'), before);
});

test('V2 intake still rejects missing contracts and records schema failures', async t => {
  const f = await fixture(t);
  f.options.evaluate = async () => { f.calls.push('review'); return { ...plan, assets: plan.assets.map(({ contract, ...asset }) => asset) }; };
  const result = await createModelingPipeline(f.options).prepare();
  assert.equal(result.status, 'PLANNING_PROVISIONAL');
  assert.equal(result.planning.lastFailure.kind, 'REVIEW_SCHEMA_INVALID');
  assert.equal(result.planning.responses.length, 4);
  assert.equal(f.calls.length, 4);
  assert.equal(await readJson(path.join(f.state, 'plan.json')), null);
});

test('missing traversal specifications reach engineering but cannot reach authoring unresolved', async t => {
  const f = await fixture(t);
  f.options.evaluate = async ({ name }) => {
    f.calls.push(name);
    return { reason: 'Player capsule and asset-local paths were not supplied.',
      assets: [{ ...plan.assets[0], description: 'A traversable doorway' }] };
  };
  const pipeline = createModelingPipeline(f.options);
  const result = await pipeline.prepare();
  assert.equal(result.status, 'PLANNING_PROVISIONAL');
  assert.equal(result.assets[0].usable, false);
  assert.equal(result.assets[0].spec.description, 'A traversable doorway');
  assert.deepEqual(f.calls, ['modeling-plan', ...Array(4).fill('modeling-engineering')]);
  await pipeline.verify();
  assert.equal(await readJson(path.join(f.state, 'plan.json')), null);
  await fs.appendFile(path.join(f.project, result.planning.responses[0].path), 'changed');
  await assert.rejects(createModelingPipeline(f.options).prepare(), error => error.kind === 'INTEGRITY_ERROR');
});

test('a new whole round cannot discard assets from the previous invalid intake response', async t => {
  const f = await fixture(t);
  let calls = 0;
  f.options.evaluate = async ({ name }) => {
    assert.equal(name, 'modeling-plan');
    calls++;
    if (calls > 1) return { reason: 'Try to omit model work.', assets: [] };
    const invalid = structuredClone(plan);
    invalid.assets[0].contract.runtime.lodTriangles = [1200];
    return invalid;
  };
  const first = await createModelingPipeline(f.options).prepare();
  assert.equal(first.status, 'PLANNING_PROVISIONAL');
  assert.equal(first.planning.repairBaseline.assets.length, 16);
  assert.match(first.planning.lastFailure.message, /cannot add or remove draft assets/);
  const next = await createModelingPipeline(f.options).prepare({ iteration: 2 });
  assert.equal(next.status, 'PLANNING_PROVISIONAL');
  assert.match(next.planning.lastFailure.message, /cannot add or remove draft assets/);
  assert.equal(calls, 8);
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
