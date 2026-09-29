import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { atomicJson, readJson, hashFile, hashValue, localPath, repositoryRoot } from './modeling-io.mjs';
import { createExecutionStore, verifyEvidence, modelingFailure } from './modeling-execution.mjs';
import { readModelingState, writeModelingState } from './modeling-state.mjs';
import { loadModelingRecovery, modelingTaskRoot } from './modeling-recovery.mjs';
import { validateSkillPlan } from './modeling-skill-routing.mjs';
import { prefersImageModeling } from './modeling-evaluation.mjs';
import { referenceFiles } from './modeling-contract.mjs';
import { modelingEnginePaths } from './modeling-unreal.mjs';

function requireThat(condition, reason) {
  if (!condition) throw modelingFailure('INTEGRITY_ERROR', 'Toolchain upgrade preflight: ' + reason);
}

function verifyRuntimeTransition(before, after) {
  const original = { ...before }, target = { ...after };
  delete original.imageGeneration; delete target.imageGeneration;
  requireThat(same(original, target), 'only image generation configuration may be added; model/CLI settings must match.');
  requireThat(same(before, after) || !before.imageGeneration && after.imageGeneration?.model === 'gpt-image-2' &&
    !after.imageGeneration.unavailable && after.imageGeneration.endpointHash,
  'existing image configuration cannot change during a harness upgrade.');
}

// Operator-only offline upgrade of a recovered task. Unlike first-round recovery,
// this preserves the production ledger and every completed/pending round exactly.
export async function upgradeModelingToolchain({ workspace, job, fromHarnessHashes, toHarnessHashes,
  fromRuntime, toRuntime, policy, productionPolicy, sourceRevision, targetRevision, unreal,
  engineSource = { harnessHashes: fromHarnessHashes, runtime: fromRuntime, revision: sourceRevision }, apply = false }) {
  const project = path.join(workspace, 'project'), task = modelingTaskRoot(workspace, job);
  const recovery = await loadModelingRecovery(project, job);
  requireThat(recovery, 'a verified task recovery identity is required.');
  const planFile = path.join(task, 'plan.json'), plan = await readJson(planFile);
  requireThat(plan && hashValue(plan) === recovery.planHash, 'frozen recovery plan changed.');
  verifyRuntimeTransition(fromRuntime, toRuntime);
  await createExecutionStore(task).assertSettled();
  const productionFile = await localPath(workspace, 'production-state/' + recovery.productionIdentity + '/iterations.json', { existing: true });
  const production = await readJson(productionFile, null, 64 * 1024 * 1024);
  requireThat(production?.protocol === 1 && same(production.policy, productionPolicy) &&
    Number.isSafeInteger(production.iteration) && production.iteration > 0 &&
    Number.isSafeInteger(production.attempts) && production.attempts >= 0 &&
    production.rounds.every(row => row.iteration < production.iteration), 'invalid production identity, rounds or policy.');
  const protectedFiles = new Map(), evidence = new Map();
  async function protect(file) { protectedFiles.set(file, await hashFile(file)); }
  function retain(rows) {
    for (const row of rows || []) {
      if (evidence.has(row.file)) requireThat(evidence.get(row.file) === row.sha256, 'conflicting evidence hashes.');
      evidence.set(row.file, row.sha256);
    }
  }
  await protect(planFile);
  await protect(path.join(task, 'recovery.json'));
  await protect(path.join(task, 'execution.json'));
  // Preserve all old production ledgers, not just the active recovered one.
  for (const entry of await fs.readdir(path.join(workspace, 'production-state'))) {
    if (/^[a-f0-9]{64}$/.test(entry)) await protect(path.join(workspace, 'production-state', entry, 'iterations.json'));
  }
  for (const round of production.rounds) retain(round.evidence);
  retain(production.best?.evidence);
  for (const entry of recovery.assets) retain(entry.referenceEvidence);
  const locks = [];
  const validators = await Promise.all(['modeling-asset-check.py', 'modeling_scene.py', 'modeling_quality.py',
    'modeling_reference.py', 'modeling-unreal-check.py'].map(name => hashFile(path.join(repositoryRoot, 'worker/tools', name))));
  for (const file of [path.join(task, 'execution-policy/toolchain-runtime.json'),
    ...(await fs.readdir(task)).filter(name => /^toolchain-.*\.json$/.test(name)).map(name => path.join(task, name))]) {
    const lock = await readJson(file);
    requireThat(same(lock.harnessHashes, fromHarnessHashes), 'source release hashes differ: ' + file);
    requireThat(same(lock.policy, policy), 'stage policy or budget changed.');
    if (lock.runtime) requireThat(same(lock.runtime, fromRuntime), 'source runtime no longer matches its pinned configuration.');
    if (lock.validatorHashes) requireThat(same(lock.validatorHashes, validators), 'geometry validators changed.');
    locks.push({ file, lock, next: { ...lock, harnessHashes: toHarnessHashes, ...(lock.runtime ? { runtime: toRuntime } : {}) } });
    await protect(file);
  }
  // Unreal has a separate identity and durable ledger outside the task directory.
  // A prior incomplete migration may leave it on an explicitly verified older release.
  const engine = modelingEnginePaths(project, job);
  const engineLock = await readJson(engine.lockFile);
  const engineExecutionFile = path.join(engine.executionRoot, 'execution.json');
  const engineExecution = await readJson(engineExecutionFile, null, 64 * 1024 * 1024);
  requireThat(engineLock || !engineExecution, 'engine ledger exists without its toolchain lock.');
  if (engineLock) {
    verifyRuntimeTransition(engineSource.runtime, toRuntime);
    requireThat(same(engineLock.harnessHashes, engineSource.harnessHashes), 'engine source release hashes differ.');
    requireThat(same(engineLock.runtime, engineSource.runtime), 'engine source runtime changed.');
    requireThat(same(engineLock.policy, policy), 'engine policy or budget changed.');
    requireThat(unreal && engineLock.unrealHash === await hashFile(unreal), 'Unreal executable changed or is unavailable.');
    await createExecutionStore(engine.executionRoot).assertSettled();
    await protect(engine.lockFile);
    if (engineExecution) {
      await protect(engineExecutionFile);
      for (const group of Object.values(engineExecution.groups)) {
        let result = group.result;
        if (group.resultEvidence) {
          const file = await localPath(engine.executionRoot, group.resultEvidence.path, { existing: true });
          retain([{ file, sha256: group.resultEvidence.sha256 }]);
          result = await readJson(file, null, 32 * 1024 * 1024);
        }
        retain(result?.evidence);
      }
    }
    locks.push({ file: engine.lockFile, lock: engineLock,
      next: { ...engineLock, harnessHashes: toHarnessHashes, runtime: toRuntime } });
  }
  const states = [], routes = [];
  for (const name of await fs.readdir(path.join(workspace, 'modeling-state'))) {
    if (!/^[a-f0-9]{20}$/.test(name)) continue;
    const file = await localPath(workspace, 'modeling-state/' + name + '/state.json', { existing: true });
    const state = await readModelingState(file);
    requireThat(state?.protocol === 2 && (!state.pending || state.pending.phase === 'ACCEPTED' && state.accepted),
      'unfinished asset attempt must settle under the original release: ' + name);
    const base = plan.assets.find(asset => asset.assetId === state.spec?.assetId);
    requireThat(base && same({ ...state.spec, referenceImages: base.referenceImages }, base) &&
      base.referenceImages.every(ref => state.spec.referenceImages.includes(ref)), 'asset contract changed: ' + name);
    const refs = [];
    for (const ref of referenceFiles(state.spec)) refs.push(await hashFile(await localPath(project, ref, { existing: true })));
    const assetLock = locks.find(row => path.basename(row.file) === 'toolchain-' + state.spec.assetId + '.json')?.lock;
    requireThat(!state.spec.contract || assetLock, 'missing asset toolchain.');
    const requirementsHash = hashValue({ taskId: job.taskId, workspaceId: job.workspaceId, spec: state.spec, referenceHashes: refs,
      ...(state.spec.contract ? { skillLockHash: assetLock.skillLockHash, validatorHashes: assetLock.validatorHashes, blenderVersion: assetLock.blenderVersion } : {}) });
    requireThat(requirementsHash === state.requirementsHash && requirementsHash.startsWith(name), 'asset identity changed: ' + name);
    if (assetLock) {
      const skill = await readJson(await localPath(project, 'tools/modeling-skills/' + assetLock.skillLockHash + '/skill-plan.json', { existing: true }));
      requireThat(skill?.lockHash === assetLock.skillLockHash, 'skill lock mismatch.');
      await validateSkillPlan(project, skill);
    }
    for (const candidate of [state.accepted, state.bestCandidate, ...Object.values(state.rounds || {}).map(round => round.stageGap)].filter(Boolean)) {
      retain(await Promise.all((candidate.files || []).map(async row => ({
        file: await localPath(project, row.path, { existing: true }), sha256: row.sha256 }))));
    }
    for (const round of Object.values(state.rounds || {})) {
      retain(round.concept?.evidence);
      if (round.generatedBase) retain([{ file: await localPath(project, round.generatedBase.modelFile, { existing: true }), sha256: round.generatedBase.sha256 }]);
    }
    const next = structuredClone(state);
    const mapped = recovery.assets.some(entry => path.resolve(workspace, entry.statePath || '') === path.resolve(file));
    if (!fromRuntime.imageGeneration && mapped && !state.accepted && state.route === 'blender_direct' && prefersImageModeling(state.spec, state.decision?.advice)) {
      const started = state.productionIteration >= production.iteration || Boolean(state.rounds?.[production.iteration]);
      next.imageRouteUpgrade = { route: 'image_tripo_blender', earliestIteration: production.iteration + Number(started),
        sourceRevision, targetRevision, reason: 'Operator-authorized reviewed image workflow; preserve all previous attempts and candidates.' };
      routes.push({ assetId: state.spec.assetId, state: name, earliestIteration: next.imageRouteUpgrade.earliestIteration });
    }
    states.push({ file, state, next });
    await protect(file);
  }
  await verifyEvidence([...evidence].map(([file, sha256]) => ({ file, sha256 })));
  const changes = [...locks.map(row => ({ file: row.file, next: row.next, kind: 'lock' })),
    ...states.filter(row => !same(row.state, row.next)).map(row => ({ file: row.file, next: row.next, kind: 'state' }))];
  const id = hashValue({ sourceRevision, targetRevision, taskId: job.taskId, executionHash: protectedFiles.get(path.join(task, 'execution.json')) }).slice(0, 24);
  const originals = [...protectedFiles].map(([file, sha256]) => ({ path: path.relative(workspace, file).replaceAll('\\', '/'), sha256 }));
  const report = { protocol: 1, id, phase: 'PREVIEW', taskId: job.taskId, workspaceId: job.workspaceId, sourceRevision, targetRevision,
    engine: engineLock ? { key: engine.key, sourceRevision: engineSource.revision,
      executionHash: protectedFiles.get(engineExecutionFile) || null, nextCall: engineExecution?.nextCall || 1,
      consumedCalls: Object.values(engineExecution?.groups || {}).reduce((sum, group) => sum + group.calls.length, 0) } : null,
    iteration: production.iteration, consumedProductionAttempts: production.attempts, completedRounds: production.rounds.length,
    productionIdentity: recovery.productionIdentity, stateCount: states.length, verifiedArtifactCount: evidence.size, routes,
    originals, changedPaths: changes.map(row => path.relative(workspace, row.file).replaceAll('\\', '/')),
    executionHash: protectedFiles.get(path.join(task, 'execution.json')),
    productionHash: protectedFiles.get(productionFile), fromRuntimeHash: hashValue(fromRuntime), toRuntimeHash: hashValue(toRuntime),
    assetBudgets: states.map(row => ({ assetId: row.state.spec.assetId, state: path.basename(path.dirname(row.file)),
      attempts: row.state.attempts, iteration: row.state.productionIteration, roundAttempts: Object.fromEntries(
        Object.entries(row.state.rounds || {}).map(([key, round]) => [key, round.attempts])) })) };
  if (!apply) return report;
  const backupRoot = await localPath(workspace, 'recovery/toolchain-' + id);
  await fs.mkdir(path.dirname(backupRoot), { recursive: true });
  await fs.mkdir(backupRoot, { recursive: false });
  for (const row of originals) {
    const file = await localPath(workspace, row.path, { existing: true }), target = await localPath(backupRoot, row.path);
    await verifyEvidence([{ file, sha256: row.sha256 }]);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(file, target, fs.constants.COPYFILE_EXCL);
    await verifyEvidence([{ file: target, sha256: row.sha256 }]);
  }
  const reportFile = path.join(backupRoot, 'upgrade.json');
  await atomicJson(reportFile, { ...report, phase: 'PREPARED' });
  for (const row of changes) {
    if (row.kind === 'state') {
      await writeModelingState(row.file, row.next);
      requireThat(same(await readModelingState(row.file), row.next), 'state serialization changed retained data.');
    } else await atomicJson(row.file, row.next);
  }
  const changed = new Set(changes.map(row => row.file));
  await verifyEvidence([...protectedFiles].filter(([file]) => !changed.has(file)).map(([file, sha256]) => ({ file, sha256 })));
  await verifyEvidence([...evidence].map(([file, sha256]) => ({ file, sha256 })));
  const final = { ...report, phase: 'COMMITTED', backupRoot, completedAt: new Date().toISOString(),
    after: await Promise.all(changes.map(async row => ({ path: path.relative(workspace, row.file).replaceAll('\\', '/'), sha256: await hashFile(row.file) }))) };
  await atomicJson(reportFile, final);
  return final;
}
