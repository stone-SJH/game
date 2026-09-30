import path from 'node:path';
import { atomicJson, hashFile, hashValue, localPath, readJson } from './modeling-io.mjs';
import { walkFiles, contentStore, checkpointEntry } from './workspace-storage.mjs';
import { verifyEvidence, createExecutionStore } from './modeling-execution.mjs';
import { readWorkspaceEpoch } from './workspace-epoch.mjs';

export async function planWorkspaceMigration({ workspace, taskId, targetCommit, targetHarness, runtime, policy, validatorHashes, revisions = [] }) {
  if (!/^[a-f0-9]{40}$/.test(targetCommit)) throw new Error('Migration requires a committed target release');
  const context = await readJson(path.join(workspace, 'project/plan/production-context.json'));
  if (context?.taskId !== taskId || context.workspaceId !== path.basename(workspace)) throw new Error('Workspace ownership mismatch');
  const pins = {}, source = [], candidates = [], budgets = [];
  for (const row of await walkFiles(path.join(workspace, 'modeling-state'))) {
    if (!row.path.endsWith('.json')) continue;
    const value = await readJson(row.file, null, 64 * 1024 * 1024);
    const relative = path.relative(workspace, row.file).split(path.sep).join('/');
    source.push({ path: relative, sha256: await hashFile(row.file) });
    if (path.basename(row.file) === 'execution.json') {
      await createExecutionStore(path.dirname(row.file)).assertSettled();
      budgets.push({ path: relative, sha256: await hashFile(row.file), calls: Object.values(value.groups).reduce((n, group) => n + group.calls.length, 0) });
    }
    if (path.basename(row.file) === 'state.json' && value.requirementsHash) {
      for (const candidate of [value.accepted, value.bestCandidate].filter(Boolean)) {
        const evidence = candidate.files.map(file => ({ file: path.join(workspace, 'project', file.path), sha256: file.sha256 }));
        await verifyEvidence(evidence);
        candidates.push({ assetId: candidate.assetId, attemptId: candidate.attemptId, accepted: candidate.quality?.accepted === true,
          evidence, decision: 'Reuse bytes; revalidate under the new precision profile. Historical quality is unchanged.' });
      }
      if (value.pending && value.pending.phase !== 'ACCEPTED') throw new Error(`Unsettled model attempt: ${row.path}`);
      budgets.push({ path: relative, attempts: value.attempts, sha256: await hashFile(row.file) });
    }
    if (/^toolchain-.*\.json$/.test(path.basename(row.file)) && value.harnessHashes) {
      const target = { ...value, harnessHashes: targetHarness };
      if (target.runtime) target.runtime = runtime;
      if (target.policy) target.policy = policy;
      if (target.validatorHashes) target.validatorHashes = validatorHashes;
      // Skill/rubric/Blender/Unreal pins are retained byte-for-byte.
      pins[relative] = { before: hashValue(value), after: hashValue(target), target };
    }
  }
  const branches = [];
  for (const row of await walkFiles(path.join(workspace, 'production-state'))) {
    if (path.basename(row.file) !== 'iterations.json') continue;
    const value = await readJson(row.file, null, 64 * 1024 * 1024);
    const relative = path.relative(workspace, row.file).split(path.sep).join('/');
    source.push({ path: relative, sha256: await hashFile(row.file) });
    const objectiveHash = path.basename(path.dirname(row.file));
    const matching = revisions.filter(revision => hashValue({ taskId, workspaceId: context.workspaceId, objective: revision.objective }) === objectiveHash);
    branches.push({ path: relative, objectiveHash, revisionIds: [...new Set(matching.map(row => row.revision_id))], attempts: value.attempts, iteration: value.iteration });
  }
  const plan = { protocol: 2, taskId, workspaceId: context.workspaceId, targetCommit, targetHarness, runtime,
    runtimeReview: 'CONFIG_BASELINE_REPLACED: retain old pins; validate the explicitly recorded target runtime and precision profile.',
    pins, source, candidates, budgets, branches, revisions, createdAt: new Date().toISOString() };
  return { ...plan, planHash: hashValue(plan) };
}

export async function checkMigration(workspace, plan) {
  const { planHash, ...contents } = plan;
  if (hashValue(contents) !== planHash) throw new Error('Migration plan digest mismatch');
  for (const row of plan.source) if (await hashFile(await localPath(workspace, row.path, { existing: true })) !== row.sha256) throw new Error(`Migration source changed: ${row.path}`);
  for (const candidate of plan.candidates) await verifyEvidence(candidate.evidence);
  return { status: 'VERIFIED', planHash, candidates: plan.candidates.length, budgets: plan.budgets };
}

export async function stageMigration(workspace, plan) {
  await checkMigration(workspace, plan);
  const store = contentStore(workspace);
  const rollback = await store.snapshot(path.join(workspace, 'project'), checkpointEntry);
  const directory = path.join(workspace, 'state-v2/epochs', plan.planHash);
  const epoch = { protocol: 2, status: 'VERIFIED', planHash: plan.planHash, taskId: plan.taskId, targetCommit: plan.targetCommit,
    pins: plan.pins, branches: plan.branches, legacyBudgets: plan.budgets, rollbackSnapshot: rollback.id, createdAt: new Date().toISOString(),
    legacyRoot: 'modeling-state', storageMode: 'legacy-ledger-with-versioned-toolchain-overlay' };
  await atomicJson(path.join(directory, 'epoch.json'), epoch);
  await atomicJson(path.join(directory, 'plan.json'), plan);
  return { status: 'STAGED', epochFile: path.join(directory, 'epoch.json'), rollbackSnapshot: rollback.id };
}

export async function activateMigration(workspace, plan, { maintenance, verifyTarget } = {}) {
  if (!maintenance || maintenance.status !== 'READY' || !maintenance.token) throw new Error('Controller maintenance fence required');
  if (plan.branches.some(branch => branch.revisionIds.length !== 1)) throw new Error('Controller revision mapping is missing or ambiguous');
  if (typeof verifyTarget !== 'function') throw new Error('Target release/runtime verifier required');
  await verifyTarget(plan);
  await checkMigration(workspace, plan);
  const file = path.join(workspace, 'state-v2/epochs', plan.planHash, 'epoch.json');
  const epoch = await readJson(file);
  if (epoch?.planHash !== plan.planHash || epoch.status !== 'VERIFIED') throw new Error('Stage and verify the complete epoch first');
  if (epoch.protocol !== 2 || epoch.taskId !== plan.taskId || epoch.targetCommit !== plan.targetCommit ||
      hashValue(epoch.pins) !== hashValue(plan.pins) || hashValue(epoch.branches) !== hashValue(plan.branches) ||
      hashValue(epoch.legacyBudgets) !== hashValue(plan.budgets)) throw new Error('Staged epoch differs from the reviewed migration plan');
  await verifyRollbackSource(workspace, epoch);
  const current = await readWorkspaceEpoch(workspace);
  if (current && current.planHash !== plan.planHash) throw new Error('Another epoch is already active');
  await atomicJson(path.join(workspace, 'state-v2/current.json'), { protocol: 2, path: path.relative(workspace, file).split(path.sep).join('/'), sha256: await hashFile(file),
    maintenance, activatedAt: new Date().toISOString() });
  return { status: 'COMMITTED', planHash: plan.planHash };
}

export async function verifyRollbackSource(workspace, epoch) {
  const store = contentStore(workspace), saved = await store.manifest(epoch.rollbackSnapshot);
  if (!saved || saved.status === 'EXPIRED' || hashValue(saved.files) !== saved.id) throw new Error('Rollback checkpoint is missing or changed');
  const current = await store.snapshot(path.join(workspace, 'project'), checkpointEntry);
  if (current.id !== epoch.rollbackSnapshot) throw new Error('Project changed after migration staging; preserve the new work and create a new plan');
}
