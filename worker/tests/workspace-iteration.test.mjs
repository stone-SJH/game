import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { contentStore, requireSpace, walkFiles } from '../agent/workspace-storage.mjs';
import { recoverService, failureKind } from '../agent/service-recovery.mjs';
import { modelingIteration, compatiblePin } from '../agent/workspace-epoch.mjs';
import { atomicJson, hashValue, hashFile } from '../agent/modeling-io.mjs';
import { planContentGc, applyContentGc } from '../agent/workspace-gc.mjs';
import { planWorkspaceMigration, stageMigration, activateMigration, checkMigration } from '../agent/workspace-migration.mjs';
import { archivePackage } from '../agent/agent.mjs';
import { createProductionIterations } from '../agent/production-iterations.mjs';
import { workspaceLock } from '../agent/workspace-lock.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-iteration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
test('ten unchanged snapshots store bytes once, changing one file preserves both recoverable revisions', async t => {
  const root = await fixture(t), project = path.join(root, 'project'); await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'mesh.blend'), Buffer.alloc(1024 * 1024, 7));
  await fs.writeFile(path.join(project, 'texture.png'), 'texture');
  const store = contentStore(root), manifests = [];
  for (let i = 0; i < 10; i++) manifests.push(await store.snapshot(project));
  assert.equal(new Set(manifests.map(row => row.id)).size, 1);
  assert.equal((await walkFiles(path.join(store.root, 'objects'))).length, 2);
  await fs.writeFile(path.join(project, 'texture.png'), 'new texture');
  const changed = await store.snapshot(project);
  assert.notEqual(changed.id, manifests[0].id);
  assert.equal((await walkFiles(path.join(store.root, 'objects'))).length, 3);
  await store.restore(manifests[0], path.join(root, 'restore'));
  assert.equal(await fs.readFile(path.join(root, 'restore/texture.png'), 'utf8'), 'texture');
});
test('disk budget fails before copying and tampered checkpoint bytes are rejected', async t => {
  const root = await fixture(t);
  await assert.rejects(requireSpace(root, 100, { reserveBytes: 20, statfs: async () => ({ bavail: 119, bsize: 1 }) }), error => error.code === 'ENOSPC');
  const source = path.join(root, 'source'); await fs.writeFile(source, 'original');
  const store = contentStore(root), object = await store.put(source);
  await fs.writeFile(store.objectPath(object.sha256), 'corrupted');
  await assert.rejects(store.put(source), error => error.kind === 'INTEGRITY_ERROR');
});
test('service breaker survives restart and exhaustion never invokes another content operation', async t => {
  const root = await fixture(t), file = path.join(root, 'service.json'); let time = 0, calls = 0;
  const options = { now: () => time, wait: async ms => { time += ms; }, maxWaitMs: 75000 };
  const unavailable = () => { calls++; throw Object.assign(new Error('HTTP 503 upstream'), { status: 503 }); };
  await assert.rejects(recoverService(file, unavailable, options), error => error.serviceBudgetExhausted);
  assert.equal(calls, 4);
  await assert.rejects(recoverService(file, unavailable, options), error => error.serviceBudgetExhausted);
  assert.equal(calls, 4);
  assert.equal(failureKind({ code: 'ENOSPC' }), 'RESOURCE_EXHAUSTED');
  assert.equal(failureKind({ status: 401 }), 'SERVICE_CONFIGURATION');
});

test('service errors after tool activity stop without replaying the author', async t => {
  const root = await fixture(t); let calls = 0;
  await assert.rejects(recoverService(path.join(root, 'service.json'), () => {
    calls++; throw Object.assign(new Error('HTTP 503 after saving source'), { retrySafe: false, stopConfirmed: true });
  }), error => error.kind === 'SERVICE_TRANSIENT');
  assert.equal(calls, 1);
});

test('workspace writers exclude GC and another run until confirmed release', async t => {
  const root = await fixture(t), release = await workspaceLock(root, { runId: 'one' });
  await assert.rejects(workspaceLock(root, { runId: 'two' }), error => error.kind === 'CONCURRENT_EXECUTION');
  await assert.rejects(applyContentGc(root, await planContentGc(root)), error => error.kind === 'CONCURRENT_EXECUTION');
  await release(); await (await workspaceLock(root, { runId: 'two' }))();
});
test('two continuations and recovery share the intended revision budget identity', async t => {
  const root = await fixture(t), job = { revisionId: 'revision-a', runId: 'run-a' };
  const first = await modelingIteration(root, job, 1);
  assert.equal(await modelingIteration(root, { ...job, runId: 'recovered-run' }, 1), first);
  assert.notEqual(await modelingIteration(root, { revisionId: 'revision-b', runId: 'run-b' }, 1), first);
});
test('Saved runtime logs cannot create another archive or package payload', async t => {
  const root = await fixture(t), project = path.join(root, 'package'); await fs.mkdir(path.join(project, 'Game/Saved/Logs'), { recursive: true });
  await fs.writeFile(path.join(project, 'Game.exe'), 'executable');
  const signal = new AbortController().signal;
  const first = await archivePackage(project, path.join(root, 'one.zip'), signal, root);
  await fs.writeFile(path.join(project, 'Game/Saved/Logs/session.log'), 'different every launch');
  const second = await archivePackage(project, path.join(root, 'two.zip'), signal, root);
  assert.equal(first, second); assert.equal(await hashFile(first), await hashFile(second));
});
test('GC marks checkpoints and refuses a plan when new roots appear', async t => {
  const root = await fixture(t), source = path.join(root, 'source'); await fs.writeFile(source, 'orphan');
  const store = contentStore(root), object = await store.put(source);
  const now = Date.now() + 8 * 86400000;
  const plan = await planContentGc(root, { now }); assert.equal(plan.candidates.length, 1);
  await atomicJson(path.join(store.root, 'pins/milestone.json'), { sha256: object.sha256 });
  await assert.rejects(applyContentGc(root, plan), /references changed/);
  assert.equal((await planContentGc(root, { now })).candidates.length, 0);
});

test('retention expires only an unpinned old round and its package caches', async t => {
  const root = await fixture(t), store = contentStore(root), source = path.join(root, 'project');
  await fs.mkdir(source); const rounds = [];
  for (let n = 0; n < 6; n++) {
    await fs.writeFile(path.join(source, 'Game.exe'), `payload-${n}`);
    const manifest = await store.snapshot(source);
    await store.restore(manifest, path.join(root, 'play', manifest.id.slice(0, 20)));
    await atomicJson(path.join(store.root, 'archives', `${manifest.id}.zip.json`), { packageDigest: manifest.id });
    rounds.push({ snapshotId: manifest.id, packageDigest: manifest.id, qualityAccepted: n === 1 });
  }
  await atomicJson(path.join(root, 'production-state/revision/iterations.json'), { rounds, best: { delivery: rounds[0] } });
  await atomicJson(path.join(store.root, 'pins/milestone.json'), { snapshotId: rounds[2].snapshotId });
  const plan = await planContentGc(root, { now: Date.now() + 8 * 86400000 });
  assert.deepEqual(plan.expiredSnapshots.map(row => row.id), [rounds[3].snapshotId]);
  assert.equal(plan.candidates.length, 3);
  await applyContentGc(root, plan);
  await assert.rejects(store.restore(await store.manifest(rounds[3].snapshotId), path.join(root, 'expired')), error => error.kind === 'SNAPSHOT_EXPIRED');
  for (const n of [0,1,2,4,5]) await store.restore(await store.manifest(rounds[n].snapshotId), path.join(root, `retained-${n}`));
});
test('migration preserves legacy pins and budgets; activation is exact, fenced and idempotent', async t => {
  const root = await fixture(t), workspace = path.join(root, 'workspace-00000000-0000-0000-0000-000000000001');
  const taskId = 'task-fixture', workspaceId = path.basename(workspace), objective = 'game';
  const before = { policy: { maxCalls: 3 }, runtime: { version: 'old' }, harnessHashes: [{ file: 'old', sha256: 'a' }] };
  const relative = 'modeling-state/tasks/fixture/execution-policy/toolchain-runtime.json';
  await atomicJson(path.join(workspace, relative), before);
  await atomicJson(path.join(workspace, 'modeling-state/tasks/fixture/execution.json'), { protocol: 3, nextCall: 2, groups: {
    first: { calls: [{ callId: 'author-1', status: 'FAILED', error: { stopConfirmed: true } }], deadlineAt: 1 } } });
  await atomicJson(path.join(workspace, 'project/plan/production-context.json'), { taskId, workspaceId });
  const identity = hashValue({ taskId, workspaceId, objective });
  const policy = { maxIterations: 10 };
  await atomicJson(path.join(workspace, `production-state/${identity}/iterations.json`), { protocol: 1, policy, attempts: 10, iteration: 10, rounds: [] });
  const plan = await planWorkspaceMigration({ workspace, taskId, targetCommit: 'b'.repeat(40), targetHarness: [{ file: 'new', sha256: 'b' }],
    runtime: { version: 'new' }, policy: before.policy, validatorHashes: [], revisions: [{ revision_id: 'revision-1', objective }] });
  assert.equal(plan.budgets[0].calls, 1);
  await stageMigration(workspace, plan);
  await assert.rejects(activateMigration(workspace, plan), /maintenance fence/);
  const options = { maintenance: { status: 'READY', token: 'fixture' }, verifyTarget: async () => {} };
  await activateMigration(workspace, plan, options); await activateMigration(workspace, plan, options);
  const resumed = await createProductionIterations({ project: path.join(workspace, 'project'), policy, job: { taskId, workspaceId, revisionId: 'revision-1' } });
  assert.equal(resumed.attempts, 10); assert.equal(resumed.iteration, 10);
  assert.equal(await modelingIteration(workspace, { revisionId: 'revision-1' }, 10), 10);
  const pin = plan.pins[relative];
  assert.equal(await compatiblePin(path.join(workspace, relative), before, pin.target), true);
  assert.equal(await compatiblePin(path.join(workspace, relative), before, { ...pin.target, runtime: { version: 'unknown' } }), false);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(workspace, relative))), before);
  // The normal reader wrote the same ledger without resetting its counters.
  const epochFile = path.join(workspace, 'state-v2/epochs', plan.planHash, 'epoch.json');
  const epoch = JSON.parse(await fs.readFile(epochFile));
  epoch.pins[relative].after = 'forged'; await atomicJson(epochFile, epoch);
  await assert.rejects(activateMigration(workspace, plan, options), /Staged epoch differs/);
  await fs.appendFile(path.join(workspace, relative), ' ');
  await assert.rejects(checkMigration(workspace, plan), /source changed/);
});
