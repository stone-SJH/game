import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { atomicJson, hashValue, hashFile, localPath, readJson, repositoryRoot } from './modeling-io.mjs';
import { createExecutionStore, verifyEvidence, modelingFailure } from './modeling-execution.mjs';
import { modelingTaskRoot } from './modeling-recovery.mjs';
import { readModelingState, writeModelingState, modelingFailureSummary } from './modeling-state.mjs';
import { referenceFiles } from './modeling-contract.mjs';

const same = isDeepStrictEqual;
function requireThat(condition, message) {
  if (!condition) throw modelingFailure('INTEGRITY_ERROR', 'Recovery preflight: ' + message);
}

// Offline migration only: callers must hold worker maintenance ownership. Every
// original file is backed up before mutations; the manifest is the commit point.
export async function migrateModelingTask({ workspace, job, fromHarnessHashes, toHarnessHashes,
  runtime, policy, sourceRevision, targetRevision, apply = false }) {
  const project = path.join(workspace, 'project'), taskRoot = modelingTaskRoot(workspace, job);
  const manifestFile = path.join(taskRoot, 'recovery.json');
  requireThat(!await readJson(manifestFile), 'task already has a recovery manifest; verify it instead of replaying migration.');
  const plan = await readJson(path.join(taskRoot, 'plan.json'));
  requireThat(Array.isArray(plan?.assets), 'missing frozen modeling plan.');
  await createExecutionStore(taskRoot).assertSettled();
  const executionFile = path.join(taskRoot, 'execution.json'), executionHash = await hashFile(executionFile);
  const lockFiles = [path.join(taskRoot, 'execution-policy/toolchain-runtime.json'),
    ...(await fs.readdir(taskRoot)).filter(name => /^toolchain-.*\.json$/.test(name)).map(name => path.join(taskRoot, name))];
  const locks = [];
  for (const file of lockFiles) {
    const lock = await readJson(file);
    requireThat(same(lock.harnessHashes, fromHarnessHashes), 'old release hashes do not match ' + file);
    requireThat(same(lock.policy, policy), 'execution policy changed; budgets must not reset.');
    if (lock.runtime) requireThat(same(lock.runtime, runtime), 'model, CLI or runtime configuration changed.');
    if (lock.validatorHashes) {
      const validators = await Promise.all(['modeling-asset-check.py', 'modeling_scene.py', 'modeling_quality.py', 'modeling_reference.py', 'modeling-unreal-check.py']
        .map(name => hashFile(path.join(repositoryRoot, 'worker/tools', name))));
      requireThat(same(validators, lock.validatorHashes), 'validator changes require a separately reviewed migration.');
    }
    locks.push({ file, lock });
  }
  const states = [];
  for (const entry of await fs.readdir(path.join(workspace, 'modeling-state'), { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{20}$/.test(entry.name)) continue;
    const file = path.join(workspace, 'modeling-state', entry.name, 'state.json');
    const state = await readModelingState(file);
    requireThat(state?.protocol === 2 && !state.pending, 'unknown state or pending author operation at ' + file);
    const base = plan.assets.find(asset => asset.assetId === state.spec?.assetId);
    // Added research references are the only allowed difference. Dimensions,
    // traversal, requirements, LOD budgets and user-provided references are exact.
    requireThat(base && same({ ...state.spec, referenceImages: base.referenceImages }, base) &&
      base.referenceImages.every(ref => state.spec.referenceImages.includes(ref)), 'asset requirements changed at ' + file);
    const referenceEvidence = [];
    for (const ref of referenceFiles(state.spec)) {
      const source = await localPath(project, ref, { existing: true });
      referenceEvidence.push({ file: source, sha256: await hashFile(source) });
    }
    const assetLock = locks.find(row => path.basename(row.file) === 'toolchain-' + state.spec.assetId + '.json')?.lock;
    requireThat(!state.spec.contract || assetLock, 'missing asset toolchain.');
    const requirementsHash = hashValue({ taskId: job.taskId, workspaceId: job.workspaceId, spec: state.spec,
      referenceHashes: referenceEvidence.map(row => row.sha256), ...(state.spec.contract ? {
        skillLockHash: assetLock.skillLockHash, validatorHashes: assetLock.validatorHashes, blenderVersion: assetLock.blenderVersion } : {}) });
    requireThat(requirementsHash === state.requirementsHash && requirementsHash.startsWith(entry.name), 'asset identity or reference bytes changed.');
    const candidate = state.accepted || state.bestCandidate;
    if (candidate) {
      requireThat(candidate.files?.length > 0 && candidate.requirementsHash === requirementsHash, 'invalid retained candidate.');
      await verifyEvidence(await Promise.all(candidate.files.map(async row => ({ file: await localPath(project, row.path, { existing: true }), sha256: row.sha256 }))));
    }
    states.push({ file, state, base, referenceEvidence, candidate });
  }
  const ledgers = [];
  for (const entry of await fs.readdir(path.join(workspace, 'production-state'), { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const file = path.join(workspace, 'production-state', entry.name, 'iterations.json');
    const state = await readJson(file, null, 64 * 1024 * 1024);
    requireThat(state?.protocol === 1 && state.iteration === 1 && state.rounds.length === 0 && !state.best,
      'this migration only joins interrupted first rounds; completed deliveries need an explicit separate migration.');
    requireThat(Number.isSafeInteger(state.attempts) && state.attempts >= 0 && (!ledgers.length || same(state.policy, ledgers[0].state.policy)), 'invalid or conflicting production budgets.');
    ledgers.push({ file, state });
  }
  requireThat(ledgers.length > 0, 'missing production ledger.');
  const id = hashValue({ taskId: job.taskId, sourceRevision, targetRevision, planHash: hashValue(plan) }).slice(0, 24);
  const productionIdentity = hashValue({ taskId: job.taskId, workspaceId: job.workspaceId, recovery: id });
  const manifest = { protocol: 1, id, taskId: job.taskId, workspaceId: job.workspaceId,
    sourceRevision, targetRevision, planHash: hashValue(plan), iteration: 1, productionIdentity, assets: [] };
  const selected = [];
  for (const base of plan.assets) {
    const matching = states.filter(row => row.state.spec.assetId === base.assetId);
    matching.sort((a, b) => Number(Boolean(b.candidate)) - Number(Boolean(a.candidate)) ||
      (b.candidate?.quality?.score || 0) - (a.candidate?.quality?.score || 0) || a.file.localeCompare(b.file));
    const best = matching[0];
    requireThat(best, 'asset has no retained first-round state: ' + base.assetId);
    selected.push(best);
    manifest.assets.push({ assetId: base.assetId, baseHash: hashValue(base),
      statePath: path.relative(workspace, best.file).replaceAll('\\', '/'), specHash: hashValue(best.state.spec),
      requirementsHash: best.state.requirementsHash, referenceEvidence: best.referenceEvidence,
      usable: Boolean(best.candidate), score: best.candidate?.quality?.score || 0 });
  }
  const originalFiles = [...states.map(row => row.file), ...locks.map(row => row.file), ...ledgers.map(row => row.file), executionFile];
  const originals = await Promise.all(originalFiles.map(async file => ({ path: path.relative(workspace, file).replaceAll('\\', '/'), sha256: await hashFile(file) })));
  const report = { ...manifest, phase: 'PREVIEW', originalFiles: originals, executionHash,
    stateCount: states.length, consumedProductionAttempts: ledgers.reduce((sum, row) => sum + row.state.attempts, 0),
    changedHarnessFiles: toHarnessHashes.filter(row => !fromHarnessHashes.some(old => old.file === row.file && old.sha256 === row.sha256)),
    assetBudgets: states.map(row => ({ path: path.relative(workspace, row.file).replaceAll('\\', '/'), attempts: row.state.attempts,
      productionIteration: row.state.productionIteration, roundAttempts: Object.fromEntries(Object.entries(row.state.rounds || {}).map(([key, value]) => [key, value.attempts])) })) };
  if (!apply) return report;
  const backupRoot = await localPath(workspace, 'recovery/' + id);
  await fs.mkdir(path.dirname(backupRoot), { recursive: true });
  await fs.mkdir(backupRoot, { recursive: false });
  for (const row of originals) {
    const source = await localPath(workspace, row.path, { existing: true }), destination = await localPath(backupRoot, row.path);
    await verifyEvidence([{ file: source, sha256: row.sha256 }]);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    await verifyEvidence([{ file: destination, sha256: row.sha256 }]);
  }
  await atomicJson(path.join(backupRoot, 'migration.json'), { ...report, phase: 'PREPARED' });
  for (const row of selected) {
    row.state.rounds ||= {}; row.state.rounds[1] ||= { attempts: {} };
    const issue = { stage: 'operator-recovery', status: 'GAP', reason: 'Retain the original iteration and finish downstream delivery before another modeling repair round.', recoveryId: id };
    row.state.rounds[1].stageGap = row.candidate ? { ...row.candidate, reused: true,
      failures: modelingFailureSummary(row.candidate.failures, row.file) } : {
      assetId: row.state.spec.assetId, spec: row.state.spec, contract: row.state.spec.contract,
      status: 'NO_USABLE_ARTIFACT', usable: false, files: [], executionFile, stateFile: row.file,
      quality: { score: 0, accepted: false, gaps: [issue], repairInstructions: 'Keep partial files and use a documented temporary engine representation to finish this round. Repair in the next complete iteration.' } };
  }
  for (const row of states) {
    await writeModelingState(row.file, row.state);
    requireThat(same(await readModelingState(row.file), JSON.parse(JSON.stringify(row.state))), 'state serialization changed retained data.');
  }
  const combined = { ...ledgers[0].state, attempts: report.consumedProductionAttempts,
    recovery: { id, originalLedgers: ledgers.map(row => path.relative(workspace, row.file).replaceAll('\\', '/')) } };
  await atomicJson(path.join(workspace, 'production-state', productionIdentity, 'iterations.json'), combined);
  for (const { file, lock } of locks) await atomicJson(file, { ...lock, harnessHashes: toHarnessHashes });
  requireThat(await hashFile(executionFile) === executionHash, 'execution ledger changed during migration.');
  await atomicJson(manifestFile, manifest);
  await atomicJson(path.join(backupRoot, 'migration.json'), { ...report, phase: 'COMMITTED', completedAt: new Date().toISOString() });
  return { ...report, phase: 'COMMITTED', backupRoot };
}
