import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicJson, hashFile, hashValue, readJson } from '../agent/modeling-io.mjs';
import { planWorkspaceMigration, stageMigration, activateMigration, checkMigration, migrationMappingsReady } from '../agent/workspace-migration.mjs';
import { modelingIteration, readWorkspaceEpoch, usesLegacyModelingBudget } from '../agent/workspace-epoch.mjs';
import { createProductionIterations } from '../agent/production-iterations.mjs';

async function recoveredFixture(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-migration-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const taskId = 'task', workspaceId = path.basename(workspace), project = path.join(workspace, 'project');
  const policy = { maxIterations: 10 }, recoveredId = hashValue({ recovered: true });
  const taskRoot = path.join(workspace, 'modeling-state/tasks', hashValue({ taskId, workspaceId }));
  await atomicJson(path.join(project, 'plan/production-context.json'), { taskId, workspaceId });
  await atomicJson(path.join(taskRoot, 'recovery.json'), {
    protocol: 1, id: 'recovery', taskId, workspaceId, productionIdentity: recoveredId, assets: [],
  });
  const recoveredFile = path.join(workspace, 'production-state', recoveredId, 'iterations.json');
  const rounds = [];
  const revisions = [1, 2, 3].map(n => ({ revision_id: 'revision-' + n, run_id: 'run-' + n, objective: 'objective-' + n }));
  for (const n of [1, 2]) {
    const reportFile = path.join(path.dirname(recoveredFile), 'deliveries', String(n), 'iteration-result.json');
    await atomicJson(reportFile, { taskId, workspaceId, runId: 'run-' + n, iteration: n });
    rounds.push({ iteration: n, reportFile, evidence: [{ file: reportFile, sha256: await hashFile(reportFile) }] });
  }
  await atomicJson(recoveredFile, { protocol: 1, policy, iteration: 3, attempts: 9, rounds, best: null, recovery: { id: 'recovery' } });
  const nativeFile = path.join(workspace, 'production-state', hashValue({ taskId, workspaceId, revisionId: 'revision-3' }), 'iterations.json');
  await atomicJson(nativeFile, { protocol: 2, policy, iteration: 1, attempts: 1, rounds: [], best: null });
  await atomicJson(path.join(workspace, 'state-v2/revisions.json'), {
    protocol: 2, next: 101000, revisions: { 'revision-3': { first: 100000, runIds: ['run-3'], budgetGrant: { authorCallsPerAsset: 3 } } },
  });
  return { workspace, project, taskId, workspaceId, policy, recoveredFile, nativeFile, rounds, revisions,
    options: { workspace, taskId, targetCommit: 'a'.repeat(40), targetHarness: [], runtime: {}, policy: {}, validatorHashes: [], revisions } };
}

test('migration maps recovered run evidence and native revisions without resetting or changing budget semantics', async t => {
  const f = await recoveredFixture(t), original = await Promise.all([f.recoveredFile, f.nativeFile].map(hashFile));
  const plan = await planWorkspaceMigration(f.options);
  assert.equal(migrationMappingsReady(plan.branches), true);
  const recovered = plan.branches.find(branch => branch.identityMode === 'recovered');
  assert.deepEqual(recovered.revisionIds, ['revision-1', 'revision-2']);
  assert.equal(plan.branches.find(branch => branch.identityMode === 'revision').budgetMode, 'revision');
  await stageMigration(f.workspace, plan);
  await activateMigration(f.workspace, plan, { maintenance: { status: 'READY', token: 'fixture' }, verifyTarget: async () => {} });
  const epoch = await readWorkspaceEpoch(f.workspace);
  assert.equal(usesLegacyModelingBudget(epoch, 'revision-2'), true);
  assert.equal(usesLegacyModelingBudget(epoch, 'revision-3'), false);
  assert.equal(await modelingIteration(f.workspace, { revisionId: 'revision-2', runId: 'run-2' }, 3), 3);
  assert.equal(await modelingIteration(f.workspace, { revisionId: 'revision-3', runId: 'run-3' }, 1), 100000);
  for (const [revisionId, attempts, iteration] of [['revision-2', 9, 3], ['revision-3', 1, 1]]) {
    const resumed = await createProductionIterations({ project: f.project, policy: f.policy,
      job: { taskId: f.taskId, workspaceId: f.workspaceId, revisionId } });
    assert.equal(resumed.attempts, attempts);
    assert.equal(resumed.iteration, iteration);
  }
  assert.deepEqual(await Promise.all([f.recoveredFile, f.nativeFile].map(hashFile)), original);
  await checkMigration(f.workspace, plan);
  const resumed = await createProductionIterations({ project: f.project, policy: f.policy,
    job: { taskId: f.taskId, workspaceId: f.workspaceId, revisionId: 'revision-3' } });
  assert.equal(await resumed.reserveAttempt(), 2);
});

test('successor migration preserves verified recovered and native mappings after protocol upgrades', async t => {
  const f = await recoveredFixture(t), activate = { maintenance: { status: 'READY', token: 'fixture' }, verifyTarget: async () => {} };
  const first = await planWorkspaceMigration(f.options);
  await stageMigration(f.workspace, first); await activateMigration(f.workspace, first, activate);
  const retained = await readJson(f.recoveredFile);
  // Normal completion upgrades an old ledger without changing its identity.
  retained.protocol = 2; retained.attempts++; retained.iteration++;
  await atomicJson(f.recoveredFile, retained);
  const before = await Promise.all([f.recoveredFile, f.nativeFile].map(hashFile));
  const second = await planWorkspaceMigration({ ...f.options, targetCommit: 'b'.repeat(40), revisions: [] });
  assert.deepEqual(second.branches.find(branch => branch.identityMode === 'recovered').revisionIds, ['revision-1', 'revision-2']);
  assert.equal(second.branches.find(branch => branch.identityMode === 'revision').budgetMode, 'revision');
  assert.equal(second.budgets.find(row => row.path.endsWith(first.branches.find(branch => branch.identityMode === 'recovered').path)).attempts, 10);
  await stageMigration(f.workspace, second); await activateMigration(f.workspace, second, activate);
  const epoch = await readWorkspaceEpoch(f.workspace);
  assert.equal(usesLegacyModelingBudget(epoch, 'revision-2'), true);
  assert.equal(usesLegacyModelingBudget(epoch, 'revision-3'), false);
  for (const [revisionId, attempts, iteration] of [['revision-2', 10, 4], ['revision-3', 1, 1]]) {
    const resumed = await createProductionIterations({ project: f.project, policy: f.policy,
      job: { taskId: f.taskId, workspaceId: f.workspaceId, revisionId } });
    assert.equal(resumed.attempts, attempts); assert.equal(resumed.iteration, iteration);
  }
  assert.deepEqual(await Promise.all([f.recoveredFile, f.nativeFile].map(hashFile)), before);
});

test('recovered revision mapping rejects changed evidence and records report hashes in its plan', async t => {
  const f = await recoveredFixture(t), plan = await planWorkspaceMigration(f.options);
  assert.equal(plan.source.filter(row => row.path.endsWith('iteration-result.json')).length, 2);
  await fs.appendFile(f.rounds[0].reportFile, ' ');
  await assert.rejects(checkMigration(f.workspace, plan), /source changed/);
  await assert.rejects(planWorkspaceMigration(f.options), error => error.kind === 'INTEGRITY_ERROR');
});

test('recovered mapping requires the correct owner, recovery identity and a known controller run', async t => {
  const f = await recoveredFixture(t);
  await assert.rejects(planWorkspaceMigration({ ...f.options, revisions: f.revisions.slice(1) }), /unambiguous controller revision/);
  const report = await readJson(f.rounds[0].reportFile);
  await atomicJson(f.rounds[0].reportFile, { ...report, taskId: 'another-task' });
  const ledger = await readJson(f.recoveredFile);
  ledger.rounds[0].evidence[0].sha256 = await hashFile(f.rounds[0].reportFile);
  await atomicJson(f.recoveredFile, ledger);
  await assert.rejects(planWorkspaceMigration(f.options), /ownership or iteration changed/);
  ledger.recovery.id = 'another-recovery';
  await atomicJson(f.recoveredFile, ledger);
  await assert.rejects(planWorkspaceMigration(f.options), /Recovered production identity changed/);
});

test('migration refuses overlapping or unknown revision ledgers while allowing verified shared recovery', async t => {
  const f = await recoveredFixture(t), plan = await planWorkspaceMigration(f.options);
  assert.equal(migrationMappingsReady([...plan.branches, { identityMode: 'objective', revisionIds: ['revision-1'] }]), false);
  assert.equal(migrationMappingsReady([{ identityMode: 'objective', revisionIds: ['revision-1', 'revision-2'] }]), false);
  assert.equal(migrationMappingsReady([...plan.branches, { identityMode: 'revision', revisionIds: [] }]), false);
  const duplicate = path.join(f.workspace, 'production-state', hashValue({ taskId: f.taskId, workspaceId: f.workspaceId, objective: 'objective-1' }), 'iterations.json');
  await atomicJson(duplicate, { protocol: 1, policy: f.policy, iteration: 1, attempts: 2, rounds: [] });
  const ambiguous = await planWorkspaceMigration(f.options);
  await assert.rejects(activateMigration(f.workspace, ambiguous, {
    maintenance: { status: 'READY', token: 'fixture' }, verifyTarget: async () => {},
  }), /mapping is missing or ambiguous/);
});
