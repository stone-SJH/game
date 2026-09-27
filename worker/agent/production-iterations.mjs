import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, hashValue, readJson, localPath } from './modeling-io.mjs';
import { fileEvidence, verifyEvidence, modelingFailure } from './modeling-execution.mjs';

export async function createProductionIterations({ job, project, policy }) {
  const root = path.join(path.dirname(project), 'production-state', hashValue({ taskId: job.taskId, workspaceId: job.workspaceId, objective: job.objective }));
  const file = path.join(root, 'iterations.json');
  const state = await readJson(file, null, 64 * 1024 * 1024) || { protocol: 1, policy, iteration: 1, attempts: 0, rounds: [], best: null };
  if (state.protocol !== 1 || hashValue(state.policy) !== hashValue(policy)) throw modelingFailure('ITERATION_POLICY_CHANGED', 'Restore the production iteration policy pinned for this task.');
  await atomicJson(file, state);
  return {
    get iteration() { return state.iteration; },
    get rounds() { return state.rounds; },
    async reserveAttempt() { state.attempts++; await atomicJson(file, state); return state.attempts; },
    async best(reason) {
      if (!state.best) return null;
      await verifyEvidence(state.best.evidence);
      return { missing: [], files: state.best.files, qualityAccepted: state.best.qualityAccepted,
        delivery: { ...state.best.delivery, ...(reason ? { stoppedReason: reason } : {}) } };
    },
    async complete({ deliverables, score, threshold, qualityAccepted, issues, quality, modeling }) {
      const iteration = state.iteration;
      const directory = path.join(root, 'deliveries', `iteration-${iteration}`);
      await fs.mkdir(directory, { recursive: true });
      const packageRoot = path.dirname(deliverables.files.packageFile), snapshotRoot = path.join(directory, 'project');
      const sourceFiles = [];
      const included = source => {
        const relative = path.relative(project, source);
        if (source === packageRoot || source.startsWith(packageRoot + path.sep)) return true;
        return !relative.split(path.sep).some(part => ['Intermediate', 'DerivedDataCache', '.git', '.codex', '__pycache__'].includes(part));
      };
      async function collect(current) {
        for (const entry of await fs.readdir(current, { withFileTypes: true })) {
          const source = await localPath(project, path.relative(project, path.join(current, entry.name)), { existing: true });
          if (!included(source)) continue;
          if (entry.isDirectory()) await collect(source); else sourceFiles.push(source);
        }
      }
      await collect(project);
      // Preserve the project and relative evidence links as well as the complete playable package.
      // This directory is outside the working project, so later repair passes cannot overwrite it.
      await fs.cp(project, snapshotRoot, { recursive: true, filter: included });
      const files = {};
      for (const [role, source] of Object.entries(deliverables.files)) {
        const relative = path.relative(project, source);
        await localPath(project, relative, { existing: true });
        files[role] = path.join(snapshotRoot, relative);
      }
      const record = { protocol: 1, kind: 'iteration-delivery', taskId: job.taskId, workspaceId: job.workspaceId, runId: job.runId,
        iteration, status: qualityAccepted ? 'ACCEPTED' : 'DELIVERED_WITH_GAPS', score, threshold,
        qualityAccepted, issues, quality, modeling, sourceWorkspace: project, retainedProject: snapshotRoot, createdAt: new Date().toISOString() };
      const reportFile = path.join(directory, 'iteration-result.json');
      await atomicJson(reportFile, record); files.iterationResult = reportFile;
      const evidence = await fileEvidence([...Object.values(files), ...sourceFiles.map(source => path.join(snapshotRoot, path.relative(project, source)))]);
      const retained = { files, evidence, qualityAccepted, delivery: record };
      state.rounds.push({ iteration, score, qualityAccepted, reportFile, files, evidence });
      if (!state.best || score > state.best.delivery.score || qualityAccepted && !state.best.qualityAccepted) state.best = retained;
      state.iteration++;
      await atomicJson(file, state);
      return { record, file: reportFile, retained: { ...deliverables, files, qualityAccepted, delivery: record } };
    },
  };
}
