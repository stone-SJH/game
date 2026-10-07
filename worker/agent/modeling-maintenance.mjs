import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, readJson, hashFile, hashValue, localPath } from './modeling-io.mjs';
import { readModelingState, writeModelingState } from './modeling-state.mjs';
import { createExecutionStore, verifyEvidence } from './modeling-execution.mjs';
import { modelingTaskRoot, recoveredModelingReferences } from './modeling-recovery.mjs';
import { createSkillPlan } from './modeling-skill-routing.mjs';

export async function verifyRetainedModelingSkills({ workspace, job, plan }) {
  if (!plan?.assets?.length) return [];
  const project = path.join(workspace, 'project'), taskRoot = modelingTaskRoot(workspace, job);
  // Recovery enriches the intake plan with its original verified references.
  // Match production's inputs without starting research or a production round.
  const recovery = await recoveredModelingReferences({ project, job, plan, iteration: null });
  const verified = [];
  for (const spec of recovery?.assets || plan.assets) {
    if (!spec.contract) continue;
    const pin = await readJson(path.join(taskRoot, `toolchain-${spec.assetId}.json`));
    if (!pin?.skillLockHash) throw new Error(`Missing retained skill pin for ${spec.assetId}`);
    await createSkillPlan({ spec, project, pinnedLockHash: pin.skillLockHash });
    verified.push(spec.assetId);
  }
  return verified;
}

function settledState(state, row) {
  return { ...state, pending: null, maintenanceSettlements: [...(state.maintenanceSettlements || []), {
    settlementId: row.sha256, pending: row.pending, failure: row.failure,
    reason: 'Confirmed failed process was stopped. Keep its attempt, deadline, evidence and every consumed budget; permit the next eligible attempt.' }] };
}

const budgetHash = state => hashValue({ attempts: state.attempts, rounds: state.rounds, revisionBudgets: state.revisionBudgets, attemptBudgets: state.attemptBudgets });

// A canceled author is terminal once its durable call confirms shutdown. The
// outer task abort may have replaced that result with a bare cancellation, so
// use the execution ledger rather than inferring shutdown from the state error.
// This retires the reservation; it does not resume, accept or refund its work.
export async function retireCanceledAuthor(state, execution) {
  const pending = state?.pending;
  if (!pending || !['AUTHORING', 'FINAL_PENDING'].includes(pending.phase)) return null;
  const failure = state.failures?.at(-1);
  if (failure?.attemptId === pending.attemptId && (failure.stopConfirmed === false || failure.executionFence)) return null;
  await execution.assertSettled();
  const ledger = await execution.snapshot();
  const calls = Object.values(ledger.groups).filter(group =>
    group.key === `author:${pending.attemptId}` || group.key === `author:${pending.attemptId}-blockout` ||
    group.key === `author:${pending.attemptId}-final` || group.key === `preview:${pending.attemptId}` ||
    group.key === `checkpoint:${pending.attemptId}`)
    .flatMap(group => group.calls.map(call => ({ group: group.key, stage: group.stage, ...call })))
    .sort((a, b) => b.startedAt - a.startedAt);
  const last = calls[0];
  if (!last || !['AUTHOR', 'PREVIEW', 'CHECKPOINT'].includes(last.stage) || last.status !== 'FAILED' ||
      last.error?.kind !== 'CANCELED' || last.error.stopConfirmed !== true || last.error.executionFence) return null;
  return { ...state, pending: null, canceledAuthorSettlements: [...(state.canceledAuthorSettlements || []), {
    iteration: state.productionIteration, pending, executionFile: execution.file,
    failure: { callId: last.callId, group: last.group, ...last.error },
    budgetHash: budgetHash(state),
    reason: 'Canceled author confirmed stopped; reservation remains consumed in its original iteration. Outputs require independent validation before use.' }] };
}

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
