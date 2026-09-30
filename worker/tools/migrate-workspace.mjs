import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { atomicJson, hashFile, hashValue, readJson, repositoryRoot } from '../agent/modeling-io.mjs';
import { modelingToolHashes, pinToolchain } from '../agent/modeling-skill-routing.mjs';
import { modelingRuntimeIdentity } from '../agent/modeling-runtime-lock.mjs';
import { executionPolicy } from '../agent/modeling-execution.mjs';
import { codexInvocation } from '../agent/production-harness.mjs';
import { planWorkspaceMigration, checkMigration, stageMigration, activateMigration, verifyRollbackSource } from '../agent/workspace-migration.mjs';
import { readWorkspaceEpoch } from '../agent/workspace-epoch.mjs';
import { planContentGc, applyContentGc } from '../agent/workspace-gc.mjs';
import { workspaceLock } from '../agent/workspace-lock.mjs';

const run = promisify(execFile), [action, workspaceArg, ...args] = process.argv.slice(2);
if (!workspaceArg || !['plan', 'stage', 'apply', 'resume-check', 'rollback', 'gc'].includes(action)) throw new Error('Usage: migrate-workspace.mjs plan|stage|apply|resume-check|rollback|gc WORKSPACE [--expect-plan-hash HASH]');
const workspace = path.resolve(workspaceArg), workerRoot = path.dirname(path.dirname(workspace));
if (path.basename(path.dirname(workspace)) !== 'workspaces' || !/^workspace-[a-f0-9-]{36}$/.test(path.basename(workspace))) throw new Error('Expected an existing worker-owned workspace');
const project = path.join(workspace, 'project');
const context = await readJson(path.join(project, 'plan/production-context.json'));
const audit = path.join(workerRoot, 'maintenance', 'workspace-iteration', path.basename(workspace));
const planFile = path.join(audit, 'plan.json'), ticketFile = path.join(audit, 'maintenance-ticket.json');
const pinnedRuntime = await readJson(path.join(workerRoot, 'config/runtime-invocation.json'));
if (pinnedRuntime) { process.env.CODEX_CMD = pinnedRuntime.command; process.env.CODEX_HOME = pinnedRuntime.codexHome; }
const invocation = codexInvocation([]);
async function target() {
  const commit = (await run('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'])).stdout.trim();
  const dirty = (await run('git', ['-C', repositoryRoot, 'status', '--porcelain', '--untracked-files=all'])).stdout.trim();
  if (dirty) throw new Error('Migration target worktree must be clean and committed');
  return { targetCommit: commit, targetHarness: await modelingToolHashes(), runtime: await modelingRuntimeIdentity(invocation, project),
    policy: executionPolicy(invocation), validatorHashes: await Promise.all(['modeling-asset-check.py','modeling_scene.py','modeling_quality.py','modeling_reference.py','modeling-unreal-check.py'].map(file => hashFile(path.join(repositoryRoot, 'worker/tools', file)))) };
}
async function quiescent() {
  if (!await fs.stat(path.join(workerRoot, 'config/autostart.paused')).catch(() => null)) throw new Error('Set autostart.paused before maintenance');
  if (await fs.stat(path.join(workerRoot, 'journal/execution.json')).catch(() => null)) throw new Error('Execution journal must settle; never delete it');
  if (process.platform === 'win32') {
    const script = "@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(UnrealEditor.*|blender)\\.exe$' -or ($_.Name -eq 'node.exe' -and $_.CommandLine -match '[\\\\/]agent[\\\\/]agent\\.mjs') }).Count";
    if (Number((await run('powershell.exe', ['-NoProfile', '-Command', script])).stdout.trim()) !== 0) throw new Error('Worker/Unreal/Blender processes must stop before migration');
  }
}
async function controller(body) {
  if (!process.env.CONTROL_URL || !process.env.WORKER_TOKEN || !process.env.WORKER_ID) throw new Error('Load the existing worker.env.ps1 first');
  const response = await fetch(process.env.CONTROL_URL.replace(/\/$/, '') + '/v1/worker/workspace-maintenance', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-worker-id': process.env.WORKER_ID, 'x-worker-token': process.env.WORKER_TOKEN },
    body: JSON.stringify({ taskId: context.taskId, ...body }), signal: AbortSignal.timeout(15000) });
  const value = await response.json();
  if (!response.ok) throw new Error(`Controller maintenance ${response.status}: ${value.error}`);
  return value;
}
async function verifyTarget(plan) {
  const current = await target();
  if (plan.targetCommit !== current.targetCommit || hashValue(plan.targetHarness) !== hashValue(current.targetHarness) || hashValue(plan.runtime) !== hashValue(current.runtime)) throw new Error('Target release/runtime changed after planning');
}
if (action === 'plan') {
  const current = await target();
  let ticket = null;
  if (!args.includes('--offline')) {
    ticket = await controller({ action: 'begin', migrationId: `iteration-${context.taskId}` });
    await atomicJson(ticketFile, ticket);
  }
  const plan = await planWorkspaceMigration({ workspace, taskId: context.taskId, ...current, revisions: ticket?.revisions || [] });
  await atomicJson(planFile, plan);
  await atomicJson(path.join(workspace, 'state-v2/migration-required.json'), { protocol: 2, planHash: plan.planHash, targetCommit: plan.targetCommit });
  console.log(JSON.stringify({ status: ticket ? 'READY' : 'OFFLINE_PLAN', planFile, planHash: plan.planHash, candidates: plan.candidates.length,
    mappingReady: plan.branches.every(branch => branch.revisionIds.length === 1), budgets: plan.budgets.map(row => ({ path: row.path, calls: row.calls, attempts: row.attempts })) }));
} else if (action === 'gc') {
  const file = path.join(audit, 'gc-plan.json');
  if (args.includes('--apply')) {
    await quiescent();
    const plan = await readJson(file, null, 64 * 1024 * 1024);
    if (!args.includes('--expect-plan-hash') || args[args.indexOf('--expect-plan-hash') + 1] !== hashValue(plan)) throw new Error('GC requires the exact reviewed dry-run digest');
    const result = await applyContentGc(workspace, plan); await atomicJson(path.join(audit, 'gc-result.json'), result); console.log(JSON.stringify(result));
  } else {
    const plan = await planContentGc(workspace); await atomicJson(file, plan);
    console.log(JSON.stringify({ status: 'DRY_RUN', planHash: hashValue(plan), ...plan }));
  }
} else if (action === 'resume-check') {
  const epoch = await readWorkspaceEpoch(workspace);
  if (!epoch) throw new Error('Migration is not active');
  const plan = await readJson(path.join(workspace, 'state-v2/epochs', epoch.planHash, 'plan.json'), null, 64 * 1024 * 1024);
  await verifyTarget(plan);
  for (const [relative, binding] of Object.entries(epoch.pins)) {
    const file = path.join(workspace, relative);
    await pinToolchain(path.dirname(file), path.basename(file).slice('toolchain-'.length, -5), binding.target);
  }
  const result = { status: 'READY_FOR_CONTINUE', planHash: epoch.planHash, targetCommit: epoch.targetCommit,
    realContinueValidated: false, legacyPinsPreserved: true };
  await atomicJson(path.join(audit, 'resume-check.json'), result); console.log(JSON.stringify(result));
} else {
  await quiescent();
  const release = await workspaceLock(workspace, { operation: action });
  try {
  const plan = await readJson(planFile, null, 64 * 1024 * 1024);
  const expected = args[args.indexOf('--expect-plan-hash') + 1];
  if (!args.includes('--expect-plan-hash') || expected !== plan?.planHash) throw new Error('Review the plan and pass its exact --expect-plan-hash');
  await verifyTarget(plan);
  if (action === 'stage') console.log(JSON.stringify(await stageMigration(workspace, plan)));
  else if (action === 'rollback') {
    await checkMigration(workspace, plan); // Refuse to roll back across new ledger writes.
    const epoch = await readWorkspaceEpoch(workspace);
    if (epoch) await verifyRollbackSource(workspace, epoch);
    const fence = await controller({ action: 'begin', migrationId: `iteration-${context.taskId}` });
    await atomicJson(ticketFile, fence);
    const pointer = path.join(workspace, 'state-v2/current.json');
    const prior = await readJson(pointer);
    if (prior) await fs.rename(pointer, path.join(audit, `rolled-back-${Date.now()}.json`));
    console.log(JSON.stringify({ status: 'ROLLED_BACK_OFFLINE', note: 'Old runtime is not restored. Keep maintenance enabled until a compatible release is ready.' }));
  } else {
    // Reacquire the same maintenance identity on every apply. This also recovers
    // a crash after remote release but before the local completion receipt.
    const ticket = await controller({ action: 'begin', migrationId: `iteration-${context.taskId}` });
    await atomicJson(ticketFile, ticket);
    const result = await activateMigration(workspace, plan, { maintenance: ticket?.maintenance, verifyTarget });
    const auth = { migrationId: ticket.maintenance.migrationId, token: ticket.maintenance.token, writeEpoch: ticket.maintenance.writeEpoch,
      planHash: plan.planHash, workerCommit: plan.targetCommit };
    await controller({ ...auth, action: 'commit' });
    await atomicJson(path.join(audit, 'commit-record.json'), result);
    await controller({ ...auth, action: 'release' });
    console.log(JSON.stringify(result));
  }
  } finally { await release(); }
}
