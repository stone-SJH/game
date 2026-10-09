import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, hashValue, readJson, localPath } from './modeling-io.mjs';
import { fileEvidence, verifyEvidence, modelingFailure } from './modeling-execution.mjs';
import { loadModelingRecovery } from './modeling-recovery.mjs';
import { contentStore, checkpointEntry, packageEntry } from './workspace-storage.mjs';
import { readWorkspaceEpoch } from './workspace-epoch.mjs';
import { coverageImproved } from './modeling-coverage.mjs';

export async function createProductionIterations({ job, project, policy }) {
  const budgetRevisionId = job.payload?.budgetRevisionId || job.revisionId;
  const recovery = job.revisionId ? null : await loadModelingRecovery(project, job);
  const identity = recovery?.productionIdentity || hashValue({ taskId: job.taskId, workspaceId: job.workspaceId,
    ...(budgetRevisionId ? { revisionId: budgetRevisionId } : { objective: job.objective }) });
  const store = contentStore(path.dirname(project));
  const workspace = path.dirname(project), epoch = await readWorkspaceEpoch(workspace);
  const legacy = epoch?.branches?.find(branch => branch.revisionIds.includes(budgetRevisionId));
  const root = legacy ? path.dirname(await localPath(workspace, legacy.path, { existing: true })) : path.join(workspace, 'production-state', identity);
  const file = path.join(root, 'iterations.json');
  let state = await readJson(file, null, 64 * 1024 * 1024);
  if (job.payload?.inputAnswer && budgetRevisionId !== job.revisionId && !state) throw modelingFailure('INTEGRITY_ERROR', 'The inherited production budget is missing; an answer cannot reset it.');
  if (recovery && !state) throw modelingFailure('INTEGRITY_ERROR', 'Recovered production ledger is missing; consumed budgets cannot restart.');
  if (!state) {
    let best = null;
    if (job.parentRevisionId) {
      const parentBudgetRevisionId = job.payload?.parentBudgetRevisionId || job.parentRevisionId;
      const parent = epoch?.branches?.find(branch => branch.revisionIds.includes(parentBudgetRevisionId));
      const parentFile = parent ? await localPath(workspace, parent.path, { existing: true })
        : path.join(workspace, 'production-state', hashValue({ taskId: job.taskId, workspaceId: job.workspaceId, revisionId: parentBudgetRevisionId }), 'iterations.json');
      const prior = await readJson(parentFile, null, 64 * 1024 * 1024);
      if (prior?.best) {
        await verifyEvidence(prior.best.evidence);
        best = { ...prior.best, inherited: true, qualityAccepted: false, delivery: { ...prior.best.delivery,
          qualityAccepted: false, inheritedFromRevision: job.parentRevisionId, requiresCurrentRevisionValidation: true } };
      }
    }
    state = { protocol: 2, policy, iteration: 1, attempts: 0, rounds: [], best };
  }
  if (![1, 2].includes(state.protocol) || hashValue(state.policy) !== hashValue(policy)) throw modelingFailure('ITERATION_POLICY_CHANGED', 'Restore the production iteration policy pinned for this task.');
  await atomicJson(file, state);
  return {
    get iteration() { return state.iteration; },
    get attempts() { return state.attempts; },
    get rounds() { return state.rounds; },
    async reserveAttempt() { state.attempts++; await atomicJson(file, state); return state.attempts; },
    async best(reason) {
      if (!state.best) return null;
      await verifyEvidence(state.best.evidence);
      return { missing: [], files: state.best.files, qualityAccepted: state.best.qualityAccepted,
        delivery: { ...state.best.delivery, ...(reason ? { stoppedReason: reason } : {}) } };
    },
    async complete({ deliverables, score, threshold, qualityAccepted, issues, quality, modeling, playable = true, productionCompleted = false, coverage = null }) {
      const iteration = state.iteration;
      const directory = path.join(root, 'deliveries', `iteration-${iteration}`);
      await fs.mkdir(directory, { recursive: true });
      const packageRoot = deliverables.files.packageFile ? path.dirname(deliverables.files.packageFile) : null;
      const manifest = await store.snapshot(project, checkpointEntry);
      // A runnable package is materialized once per payload, at a short path for
      // third-party Windows DLL loading. Project recovery uses the CAS manifest.
      const packageManifest = packageRoot ? await store.snapshot(packageRoot, packageEntry) : null;
      const snapshotRoot = packageManifest ? path.join(path.dirname(project), 'play', packageManifest.id.slice(0, 20)) : null;
      if (packageManifest) await store.restore(packageManifest, snapshotRoot);
      const files = {};
      for (const [role, source] of Object.entries(deliverables.files)) {
        const relative = path.relative(project, source);
        await localPath(project, relative, { existing: true });
        if (packageRoot && (source === packageRoot || source.startsWith(packageRoot + path.sep))) files[role] = path.join(snapshotRoot, path.relative(packageRoot, source));
        else {
          const object = await store.put(source);
          const retained = path.join(store.root, 'views', object.sha256, path.basename(source));
          await store.restore({ id: hashValue([{ path: path.basename(source), ...object }]), files: [{ path: path.basename(source), ...object }] }, path.dirname(retained));
          files[role] = retained;
        }
      }
      const record = { protocol: 1, kind: 'iteration-delivery', taskId: job.taskId, workspaceId: job.workspaceId, runId: job.runId,
        revisionId: job.revisionId || null, productionCompleted, coverage,
        iteration, status: !playable ? 'RETAINED_INCOMPLETE' : qualityAccepted ? 'ACCEPTED' : 'DELIVERED_WITH_GAPS', score, threshold, playable,
        publishable: playable && ['projectFile', 'scenePreview', 'packageFile', 'acceptanceReport'].every(role => files[role]),
        qualityAccepted, issues, quality, modeling, sourceWorkspace: project, retainedProject: null,
        snapshotManifest: path.join(store.root, 'manifests', `${manifest.id}.json`),
        snapshotId: manifest.id, packageDigest: packageManifest?.id || null, createdAt: new Date().toISOString() };
      const reportFile = path.join(directory, 'iteration-result.json');
      await atomicJson(reportFile, record); files.iterationResult = reportFile;
      const evidence = await fileEvidence([...Object.values(files), ...(packageManifest?.files || []).map(row => path.join(snapshotRoot, row.path))]);
      const retained = { files, evidence, qualityAccepted, delivery: record };
      state.rounds.push({ iteration, score, qualityAccepted, reportFile, snapshotId: manifest.id, packageDigest: packageManifest?.id || null, coverage });
      const priorPlayable = state.best?.delivery.playable !== false;
      const priorPublishable = state.best?.delivery.publishable === true;
      const previousRevision = state.best && (state.best.inherited || (job.revisionId
        ? state.best.delivery.revisionId !== job.revisionId : state.best.delivery.runId !== job.runId));
      if (!state.best || productionCompleted && (!state.best.delivery.productionCompleted || previousRevision) || record.publishable && state.best.inherited || record.publishable && !priorPublishable || record.publishable === priorPublishable &&
        (playable && !priorPlayable || playable === priorPlayable &&
        (score > state.best.delivery.score || qualityAccepted && !state.best.qualityAccepted || coverageImproved(state.best.delivery.coverage, coverage)))) state.best = retained;
      state.iteration++;
      state.protocol = 2;
      await atomicJson(file, state);
      return { record, file: reportFile, retained: { ...deliverables, files, qualityAccepted, delivery: record } };
    },
  };
}
