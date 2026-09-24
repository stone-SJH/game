import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createExecutionStore, fileEvidence, modelingFailure } from '../agent/modeling-execution.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modeling-execution-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const options = { key: 'visual/asset-1', stage: 'REVIEW', timeoutMs: 100, maxCalls: 3, retry: () => true };

test('reserved call after crash fences recovery, without reusing its id or budget', async t => {
  const root = await fixture(t); let invoked = 0;
  await assert.rejects(createExecutionStore(root).run({ ...options, onReserved: () => { throw new Error('crash'); } }, () => invoked++), /crash/);
  const resumed = createExecutionStore(root);
  await assert.rejects(resumed.run(options, () => invoked++), error => error.kind === 'STOP_UNCONFIRMED');
  assert.equal(invoked, 0);
  assert.equal((await resumed.snapshot()).nextCall, 2);
});

test('retry errors and exhaustion survive restart and retain each call', async t => {
  const root = await fixture(t); let count = 0;
  const invoke = () => { count++; throw modelingFailure('REVIEW_SCHEMA_INVALID', 'response.criteria is missing'); };
  await assert.rejects(createExecutionStore(root).run(options, invoke), error => error.kind === 'VALIDATION_INFRASTRUCTURE_EXHAUSTED');
  await assert.rejects(createExecutionStore(root).run(options, invoke), error => error.kind === 'VALIDATION_INFRASTRUCTURE_EXHAUSTED');
  const state = await createExecutionStore(root).snapshot();
  assert.equal(count, 3); assert.equal(state.nextCall, 4);
  assert.equal(Object.values(state.groups)[0].calls.length, 3);
});

test('successful result resumes without invoking tools, but changed evidence is rejected', async t => {
  const root = await fixture(t), asset = path.join(root, 'model.glb');
  await fs.writeFile(asset, 'original');
  const request = { ...options, evidence: await fileEvidence([asset]) }; let count = 0;
  const invoke = () => { count++; return { criteria: ['PASS'] }; };
  await createExecutionStore(root).run(request, invoke);
  assert.deepEqual(await createExecutionStore(root).run(request, invoke), { criteria: ['PASS'] });
  assert.equal(count, 1);
  await fs.writeFile(asset, 'changed');
  await assert.rejects(createExecutionStore(root).run(request, invoke), error => error.kind === 'INTEGRITY_ERROR');
});

test('elapsed stage deadline does not reset on restart and changed limits are rejected', async t => {
  const root = await fixture(t); let tick = 0, count = 0;
  await assert.rejects(createExecutionStore(root, { now: () => tick }).run(options, () => {
    count++; tick = 301; throw new Error('service error');
  }), error => error.kind === 'VALIDATION_INFRASTRUCTURE_EXHAUSTED');
  await assert.rejects(createExecutionStore(root, { now: () => tick }).run(options, () => count++), /exhausted/);
  await assert.rejects(createExecutionStore(root).run({ ...options, maxCalls: 4 }, () => count++), /limits changed/);
  assert.equal(count, 1);
});

test('cancellation and unconfirmed stop never retry', async t => {
  for (const mode of ['cancel', 'unknown-stop']) {
    const root = path.join(await fixture(t), mode), controller = new AbortController(); let count = 0;
    await assert.rejects(createExecutionStore(root, { signal: controller.signal }).run(options, () => {
      count++;
      if (mode === 'cancel') controller.abort(new Error('operator canceled'));
      throw Object.assign(new Error(mode), mode === 'unknown-stop' ? { stopConfirmed: false } : {});
    }));
    assert.equal(count, 1);
  }
});
