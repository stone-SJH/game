import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicJson, readJson, hashFile, hashValue } from '../agent/modeling-io.mjs';
import { readModelingState } from '../agent/modeling-state.mjs';
import { planPendingSettlement, applyPendingSettlement } from '../agent/modeling-maintenance.mjs';

async function fixture(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'settle-pending-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const job = { taskId: 'task', workspaceId: path.basename(workspace) };
  await atomicJson(path.join(workspace, 'project/plan/production-context.json'), job);
  const file = path.join(workspace, 'modeling-state', 'a'.repeat(20), 'state.json');
  const state = { protocol: 2, spec: { assetId: 'rock' }, attempts: { image_tripo_blender: 2 },
    rounds: { 12: { attempts: { image_tripo_blender: 2 } } }, revisionBudgets: { revision: { attempts: { image_tripo_blender: 2 } } },
    attemptBudgets: { 'rock-2': { startedAt: 1, deadlineAt: 100 } },
    pending: { attemptId: 'rock-2', phase: 'AUTHORING', route: 'image_tripo_blender' }, failures: [{ kind: 'SERVICE_TRANSIENT' }] };
  const execution = path.join(workspace, 'modeling-state/tasks', hashValue(job), 'execution.json');
  await atomicJson(execution, { protocol: 2, nextCall: 9, groups: { group: { key: 'author:rock-2-blockout', stage: 'AUTHOR',
    calls: [{ callId: 'author-8', startedAt: 1, status: 'FAILED', error: { kind: 'SERVICE_TRANSIENT', stopConfirmed: true } }] } } });
  await atomicJson(file, state);
  return { workspace, file, state, execution };
}

test('offline settlement archives a stopped failure and preserves budgets and execution bytes, including crash recovery', async t => {
  const f = await fixture(t), before = await hashFile(f.execution), plan = await planPendingSettlement(f.workspace);
  assert.equal(plan.repairs.length, 1); assert.deepEqual(await readModelingState(f.file), f.state);
  const result = await applyPendingSettlement(f.workspace, plan), after = await readModelingState(f.file);
  assert.equal(result.settled, 1); assert.equal(after.pending, null);
  for (const key of ['attempts', 'rounds', 'revisionBudgets', 'attemptBudgets', 'failures']) assert.deepEqual(after[key], f.state[key]);
  assert.deepEqual(after.maintenanceSettlements[0].pending, f.state.pending); assert.equal(await hashFile(f.execution), before);
  assert.deepEqual(await applyPendingSettlement(f.workspace, plan), result);
  await fs.unlink(path.join(f.workspace, 'recovery', `settled-pending-${plan.planHash}`, 'receipt.json'));
  assert.deepEqual(await applyPendingSettlement(f.workspace, plan), result);
});

test('unconfirmed, live and changed execution evidence cannot be settled', async t => {
  const f = await fixture(t), ledger = await readJson(f.execution);
  const plan = await planPendingSettlement(f.workspace);
  ledger.groups.group.calls[0].error.stopConfirmed = false; await atomicJson(f.execution, ledger);
  await assert.rejects(planPendingSettlement(f.workspace), /verify its process tree/);
  await assert.rejects(applyPendingSettlement(f.workspace, plan), /evidence changed/);
  ledger.groups.group.calls[0].error.stopConfirmed = true; ledger.groups.group.calls[0].status = 'STARTED'; await atomicJson(f.execution, ledger);
  await assert.rejects(planPendingSettlement(f.workspace), /verify its process tree/);
  assert.deepEqual(await readModelingState(f.file), f.state);
});
