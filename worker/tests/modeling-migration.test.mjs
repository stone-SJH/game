import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicJson, readJson, hashValue, hashFile } from '../agent/modeling-io.mjs';
import { migrateModelingTask } from '../agent/modeling-migration.mjs';
import { modelingTaskRoot, recoveredModelingReferences } from '../agent/modeling-recovery.mjs';
import { readModelingState } from '../agent/modeling-state.mjs';
import { createModelingPipeline } from '../agent/modeling-pipeline.mjs';
import { createProductionIterations } from '../agent/production-iterations.mjs';
import { executionPolicy } from '../agent/modeling-execution.mjs';
import { modelingRuntimeIdentity } from '../agent/modeling-runtime-lock.mjs';
import { modelingToolHashes } from '../agent/modeling-skill-routing.mjs';
import { prepareModelingReferences } from '../agent/modeling-research.mjs';
import { defaultContract } from '../agent/modeling-contract.mjs';

async function fixture(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'modeling-migration-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const project = path.join(workspace, 'project'), output = path.join(workspace, 'next-run');
  await fs.mkdir(project); await fs.mkdir(output);
  const job = { taskId: 'task', workspaceId: 'workspace', runId: 'next', objective: 'Continue existing workspace' };
  const invocation = { command: process.execPath, args: [] };
  const root = modelingTaskRoot(workspace, job), policy = executionPolicy(invocation);
  const runtime = await modelingRuntimeIdentity(invocation, project);
  const fromHarnessHashes = [{ file: 'agent/modeling-pipeline.mjs', sha256: '0'.repeat(64) }], toHarnessHashes = await modelingToolHashes();
  const base = { assetId: 'retained', description: 'A red fixture', prompt: 'A red fixture', requirements: ['Red body'],
    referenceImages: [], maxTriangles: 100, requireRig: false, requireClosedMesh: false };
  const missing = { ...base, assetId: 'partial' };
  const plan = { reason: 'Frozen original requirements', assets: [base, missing] };
  await atomicJson(path.join(root, 'plan.json'), plan);
  await fs.writeFile(path.join(project, 'reference.png'), 'retained reference');
  await fs.writeFile(path.join(project, 'original.blend'), 'original generated model');
  const states = [];
  for (const [asset, references, score] of [[base, ['reference.png'], 83], [base, [], 67], [missing, [], null]]) {
    const spec = { ...asset, referenceImages: references }, referenceHashes = [];
    for (const ref of references) referenceHashes.push(await hashFile(path.join(project, ref)));
    const requirementsHash = hashValue({ taskId: job.taskId, workspaceId: job.workspaceId, spec, referenceHashes });
    const file = path.join(workspace, 'modeling-state', requirementsHash.slice(0, 20), 'state.json');
    const candidate = score === null ? null : { assetId: asset.assetId, requirementsHash, spec, attemptId: 'old-' + score,
      status: 'DCC_PROVISIONAL', usable: true, quality: { score, accepted: false, gaps: [{ status: 'GAP' }] },
      files: [{ path: 'original.blend', sha256: await hashFile(path.join(project, 'original.blend')) }], failures: [] };
    const state = { protocol: 2, requirementsHash, spec, attempts: { blender_direct: 3 }, route: 'blender_direct',
      productionIteration: 1, rounds: { 1: { attempts: { blender_direct: 3 } } }, pending: null, failures: [],
      bestCandidate: candidate, feedback: { geometry: 'x'.repeat(2200000) } };
    await atomicJson(file, state); states.push({ file, state });
  }
  await atomicJson(path.join(root, 'execution-policy/toolchain-runtime.json'), { policy, runtime, harnessHashes: fromHarnessHashes });
  const execution = { protocol: 3, nextCall: 4, groups: { original: { key: 'old-review', stage: 'REVIEW', deadlineAt: 123,
    calls: [{ callId: 'review-3', status: 'FAILED', error: { stopConfirmed: true } }] } } };
  await atomicJson(path.join(root, 'execution.json'), execution);
  for (const count of [3, 6]) await atomicJson(path.join(workspace, 'production-state', hashValue(count), 'iterations.json'), {
    protocol: 1, policy: { maxIterations: 10, timeoutMs: 1200000, scoreThreshold: 85 }, iteration: 1, attempts: count, rounds: [], best: null });
  return { workspace, project, output, root, job, invocation, plan, execution, states,
    options: { workspace, job, fromHarnessHashes, toHarnessHashes, policy, runtime, sourceRevision: 'old', targetRevision: 'tested' } };
}

test('offline migration preserves artifacts and consumed budgets, then Continue reuses the highest-scoring round without new calls', async t => {
  const f = await fixture(t), execFile = path.join(f.root, 'execution.json'), originalHash = await hashFile(execFile);
  const preview = await migrateModelingTask(f.options);
  assert.equal(preview.phase, 'PREVIEW'); assert.equal(preview.consumedProductionAttempts, 9);
  assert.equal((await readJson(f.states[0].file, null, 64000000)).protocol, 2);
  const migrated = await migrateModelingTask({ ...f.options, apply: true });
  assert.equal(migrated.assets[0].score, 83); assert.equal(migrated.assets[1].usable, false);
  assert.equal(await hashFile(execFile), originalHash);
  for (const row of f.states) {
    const restored = await readModelingState(row.file);
    assert.deepEqual(restored.attempts, row.state.attempts); assert.equal(restored.feedback.geometry.length, 2200000);
    assert.deepEqual(restored.rounds[1].attempts, row.state.rounds[1].attempts);
  }
  for (const row of migrated.originalFiles) assert.equal(await hashFile(path.join(migrated.backupRoot, row.path)), row.sha256);
  const ledger = await createProductionIterations({ job: f.job, project: f.project, policy: { maxIterations: 10, timeoutMs: 1200000, scoreThreshold: 85 } });
  assert.equal(await ledger.reserveAttempt(), 10); assert.equal(ledger.iteration, 1);
  const forbidden = async () => { throw new Error('Unexpected new author/review call'); };
  const pipeline = createModelingPipeline({ ...f, signal: new AbortController().signal, step: forbidden, evaluate: forbidden, build: forbidden,
    probe: forbidden, provider: { availability: forbidden, balance: forbidden } });
  const result = await pipeline.prepare();
  assert.equal(result.assets.length, 2); assert.equal(result.assets[0].quality.score, 83);
  assert.equal(result.assets[0].reused, true); assert.equal(result.assets[1].status, 'NO_USABLE_ARTIFACT');
  await pipeline.verify();
  const after = await readJson(execFile, null, 64000000);
  assert.deepEqual(after.groups.original, f.execution.groups.original);
  assert.equal(Object.keys(after.groups).length, 1); // Even capability/provider discovery is unnecessary.
  assert.equal(await fs.readFile(path.join(f.project, 'original.blend'), 'utf8'), 'original generated model');
  const revised = { ...f.plan, assets: f.plan.assets.map(asset => ({ ...asset, maxTriangles: 200 })) };
  assert.equal(await recoveredModelingReferences({ project: f.project, job: f.job, plan: revised, iteration: 2 }), null);
  const next = await recoveredModelingReferences({ project: f.project, job: f.job, plan: f.plan, iteration: 2 });
  assert.equal(next.skipResearch, false); assert.deepEqual(next.assets[0].referenceImages, ['reference.png']);
  await fs.unlink(path.join(f.workspace, 'production-state', migrated.productionIdentity, 'iterations.json'));
  await assert.rejects(createProductionIterations({ job: f.job, project: f.project, policy: {} }), /consumed budgets cannot restart/);
});

test('a partial revision keeps unchanged recovered references and budgets without reusing the old whole-round handoff', async t => {
  const f = await fixture(t);
  await migrateModelingTask({ ...f.options, apply: true });
  const revisedAsset = { ...f.plan.assets[1], maxTriangles: 200, prompt: 'Faithful original reference', contract: defaultContract() };
  const addedAsset = { ...revisedAsset, assetId: 'added' };
  const revised = { ...f.plan, revisions: 1, assets: [f.plan.assets[0], revisedAsset, addedAsset] };
  const files = [path.join(f.root, 'recovery.json'), path.join(f.root, 'execution.json'), ...f.states.map(row => row.file)];
  const before = await Promise.all(files.map(hashFile));
  for (const iteration of [null, 1, 2]) {
    const result = await recoveredModelingReferences({ project: f.project, job: f.job, plan: revised, iteration });
    assert.ok(result, 'Unchanged assets must retain their verified reference identity');
    assert.deepEqual(result.assets[0].referenceImages, ['reference.png']);
    assert.deepEqual(result.assets.slice(1), [revisedAsset, addedAsset]);
    assert.deepEqual(result.frozenAssetIds, ['retained']);
    assert.equal(result.skipResearch, false);
    assert.deepEqual(result.handoffs, []);
    assert.equal(result.record.evidence.length, 1);
  }
  const recovered = await recoveredModelingReferences({ project: f.project, job: f.job, plan: revised, iteration: 2 });
  let researchCalls = 0;
  const researched = await prepareModelingReferences({ ...f, assets: recovered.assets, frozenAssetIds: recovered.frozenAssetIds,
    iteration: 2, signal: new AbortController().signal, reportProgress: async () => {}, review: async () => {
      researchCalls++;
      return { references: [], blocked: [revisedAsset, addedAsset].map(asset => ({ assetId: asset.assetId, reason: 'No verified new image' })) };
    } });
  assert.equal(researchCalls, 1);
  assert.equal(researched.record.issue, undefined);
  assert.deepEqual(researched.assets[0].referenceImages, ['reference.png']);
  assert.deepEqual(researched.record.blocked.map(row => row.assetId), ['partial', 'added']);
  assert.deepEqual(await Promise.all(files.map(hashFile)), before);
  await fs.appendFile(path.join(f.project, 'reference.png'), 'changed');
  await assert.rejects(recoveredModelingReferences({ project: f.project, job: f.job, plan: revised, iteration: 2 }), { kind: 'INTEGRITY_ERROR' });
});

test('partial revisions still reject changed retained state and original-plan recovery mismatches', async t => {
  const f = await fixture(t);
  await migrateModelingTask({ ...f.options, apply: true });
  const revised = { ...f.plan, assets: [f.plan.assets[0]] };
  const state = await readModelingState(f.states[0].file);
  await atomicJson(f.states[0].file, { ...state, spec: { ...state.spec, maxTriangles: 999 } });
  await assert.rejects(recoveredModelingReferences({ project: f.project, job: f.job, plan: revised, iteration: 2 }), { kind: 'INTEGRITY_ERROR' });
  const recordFile = path.join(f.root, 'recovery.json'), record = await readJson(recordFile);
  record.assets[0].baseHash = '0'.repeat(64);
  await atomicJson(recordFile, record);
  await assert.rejects(recoveredModelingReferences({ project: f.project, job: f.job, plan: f.plan, iteration: 2 }), /Recovery asset contract changed/);
});

test('migration refuses changed runtime, unfinished calls, altered references or nonempty completed rounds before writing', async t => {
  const f = await fixture(t);
  await assert.rejects(migrateModelingTask({ ...f.options, apply: true, runtime: { changed: true } }), /runtime configuration changed/);
  f.execution.groups.original.calls[0].status = 'STARTED'; await atomicJson(path.join(f.root, 'execution.json'), f.execution);
  await assert.rejects(migrateModelingTask({ ...f.options, apply: true }), { kind: 'STOP_UNCONFIRMED' });
  f.execution.groups.original.calls[0].status = 'FAILED'; await atomicJson(path.join(f.root, 'execution.json'), f.execution);
  await fs.writeFile(path.join(f.project, 'reference.png'), 'changed');
  await assert.rejects(migrateModelingTask({ ...f.options, apply: true }), /identity or reference bytes changed/);
  await fs.writeFile(path.join(f.project, 'reference.png'), 'retained reference');
  const file = path.join(f.workspace, 'production-state', hashValue(3), 'iterations.json');
  const state = await readJson(file); state.rounds.push({ iteration: 1 }); await atomicJson(file, state);
  await assert.rejects(migrateModelingTask({ ...f.options, apply: true }), /completed deliveries/);
  assert.equal((await readJson(f.states[0].file, null, 64000000)).protocol, 2);
  await assert.rejects(fs.stat(path.join(f.workspace, 'recovery')), { code: 'ENOENT' });
});
