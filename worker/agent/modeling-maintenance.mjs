import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, readJson, hashFile, hashValue, localPath } from './modeling-io.mjs';
import { readModelingState, writeModelingState } from './modeling-state.mjs';
import { createExecutionStore, verifyEvidence } from './modeling-execution.mjs';

function settledState(state, row) {
  return { ...state, pending: null, maintenanceSettlements: [...(state.maintenanceSettlements || []), {
    settlementId: row.sha256, pending: row.pending, failure: row.failure,
    reason: 'Confirmed failed process was stopped. Keep its attempt, deadline, evidence and every consumed budget; permit the next eligible attempt.' }] };
}

const budgetHash = state => hashValue({ attempts: state.attempts, rounds: state.rounds, revisionBudgets: state.revisionBudgets, attemptBudgets: state.attemptBudgets });

// Offline repair only. The caller owns the stopped worker and workspace lock.
// Retire an already failed, confirmed-stopped call; never replay or refund it.
export async function planPendingSettlement(workspace) {
  const context = await readJson(path.join(workspace, 'project/plan/production-context.json'));
  if (!context?.taskId || context.workspaceId !== path.basename(workspace)) throw new Error('Workspace ownership mismatch');
  const root = path.join(workspace, 'modeling-state');
  const taskRoot = path.join(root, 'tasks', hashValue({ taskId: context.taskId, workspaceId: context.workspaceId }));
  const execution = createExecutionStore(taskRoot);
  await execution.assertSettled();
  const ledger = await execution.snapshot(), repairs = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{20}$/.test(entry.name)) continue;
    const file = path.join(root, entry.name, 'state.json'), state = await readModelingState(file);
    if (!state?.pending || state.pending.phase === 'ACCEPTED') continue;
    const groups = Object.values(ledger.groups).filter(group => group.identity?.attemptId === state.pending.attemptId ||
      group.key === `preview:${state.pending.attemptId}` || group.key.startsWith(`author:${state.pending.attemptId}-`));
    const calls = groups.flatMap(group => group.calls.map(call => ({ group: group.key, ...call }))).sort((a, b) => b.startedAt - a.startedAt);
    const last = calls[0];
    if (!last || last.status !== 'FAILED' || last.error?.stopConfirmed !== true)
      throw new Error(`Pending attempt ${state.pending.attemptId} has no confirmed-stopped failure; retain the fence.`);
    const row = { path: path.relative(workspace, file).replaceAll('\\', '/'), sha256: await hashFile(file),
      pending: state.pending, failure: { callId: last.callId, group: last.group, kind: last.error.kind, stopConfirmed: true },
      budgetHash: budgetHash(state) };
    repairs.push({ ...row, afterStateHash: hashValue(settledState(state, row)) });
  }
  const plan = { protocol: 1, taskId: context.taskId, workspaceId: context.workspaceId, repairs,
    execution: { file: execution.file, sha256: await hashFile(execution.file) } };
  return { ...plan, planHash: hashValue(plan) };
}

export async function applyPendingSettlement(workspace, plan) {
  const { planHash, ...contents } = plan;
  if (hashValue(contents) !== planHash) throw new Error('Pending settlement plan hash changed');
  await verifyEvidence([plan.execution]);
  const backup = path.join(workspace, 'recovery', `settled-pending-${planHash}`);
  const receiptFile = path.join(backup, 'receipt.json');
  const receipt = await readJson(receiptFile);
  if (receipt?.status === 'COMMITTED') {
    await verifyEvidence(receipt.after.map(row => ({ file: path.join(workspace, row.path), sha256: row.sha256 })));
    return receipt;
  }
  const current = await planPendingSettlement(workspace);
  if (current.taskId !== plan.taskId || current.workspaceId !== plan.workspaceId ||
      current.repairs.some(row => !plan.repairs.some(planned => hashValue(planned) === hashValue(row)))) throw new Error('Pending settlement inputs changed; plan again');
  const remaining = [];
  for (const row of plan.repairs) {
    const file = await localPath(workspace, row.path, { existing: true }), state = await readModelingState(file);
    if (hashValue(state) === row.afterStateHash) continue; // Recover a crash before the final receipt.
    if (await hashFile(file) !== row.sha256) throw new Error('Pending settlement state changed; retain the fence');
    remaining.push(row);
  }
  await atomicJson(path.join(backup, 'plan.json'), plan);
  for (const row of remaining) {
    const source = await localPath(workspace, row.path, { existing: true }), destination = await localPath(backup, row.path);
    await verifyEvidence([{ file: source, sha256: row.sha256 }]);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    try { await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await verifyEvidence([{ file: destination, sha256: row.sha256 }]);
  }
  const after = [];
  for (const row of remaining) {
    const file = await localPath(workspace, row.path, { existing: true }), state = settledState(await readModelingState(file), row);
    if (budgetHash(state) !== row.budgetHash || hashValue(state) !== row.afterStateHash)
      throw new Error('Pending settlement changed a budget');
    await writeModelingState(file, state);
  }
  for (const row of plan.repairs) after.push({ path: row.path, sha256: await hashFile(await localPath(workspace, row.path, { existing: true })) });
  await verifyEvidence([plan.execution]);
  const result = { status: 'COMMITTED', planHash, settled: after.length, after, budgetsPreserved: true, executionPreserved: true };
  await atomicJson(receiptFile, result);
  return result;
}
