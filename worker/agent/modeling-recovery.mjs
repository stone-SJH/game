import path from 'node:path';
import { hashValue, readJson, localPath } from './modeling-io.mjs';
import { modelingFailure, verifyEvidence } from './modeling-execution.mjs';
import { readModelingState } from './modeling-state.mjs';

export function modelingTaskRoot(workspace, job) {
  return path.join(workspace, 'modeling-state', 'tasks', hashValue({ taskId: job.taskId, workspaceId: job.workspaceId }));
}

// Created only by the offline, operator-authorized migration tool. A Continue
// message can change the objective text without discarding the task's ledger.
export async function loadModelingRecovery(project, job) {
  const file = path.join(modelingTaskRoot(path.dirname(project), job), 'recovery.json');
  const record = await readJson(file);
  if (!record) return null;
  if (record.protocol !== 1 || record.taskId !== job.taskId || record.workspaceId !== job.workspaceId ||
      !/^[a-f0-9]{64}$/.test(record.productionIdentity || '') || !Array.isArray(record.assets)) {
    throw modelingFailure('INTEGRITY_ERROR', 'Invalid operator modeling recovery record.');
  }
  return record;
}

export async function recoveredModelingReferences({ project, job, plan, iteration }) {
  const record = await loadModelingRecovery(project, job);
  // A real specification revision goes through normal research and authoring.
  if (!record || record.planHash !== hashValue(plan)) return null;
  const assets = [], evidence = [], handoffs = [], frozenAssetIds = [];
  for (const spec of plan.assets) {
    const entry = record.assets.find(row => row.assetId === spec.assetId);
    if (!entry || entry.baseHash !== hashValue(spec)) throw modelingFailure('INTEGRITY_ERROR', 'Recovery asset contract changed.');
    if (!entry.statePath) { assets.push(spec); continue; }
    const file = await localPath(path.dirname(project), entry.statePath, { existing: true });
    const state = await readModelingState(file);
    if (state?.requirementsHash !== entry.requirementsHash || hashValue(state.spec) !== entry.specHash) {
      throw modelingFailure('INTEGRITY_ERROR', 'Recovered asset state does not match its frozen contract.');
    }
    await verifyEvidence(entry.referenceEvidence);
    frozenAssetIds.push(spec.assetId);
    assets.push(state.spec); evidence.push(...entry.referenceEvidence);
    if (iteration === record.iteration) {
      const handoff = state.rounds?.[iteration]?.stageGap;
      if (!handoff || handoff.assetId !== spec.assetId || !Array.isArray(handoff.files) ||
          Boolean(handoff.usable) !== entry.usable || handoff.quality?.score !== entry.score) {
        throw modelingFailure('INTEGRITY_ERROR', 'Recovered first-round handoff changed.');
      }
      const files = await Promise.all(handoff.files.map(async row => ({
        file: await localPath(project, row.path, { existing: true }), sha256: row.sha256 })));
      await verifyEvidence(files); evidence.push(...files); handoffs.push(handoff);
    }
  }
  return { assets, handoffs, frozenAssetIds, skipResearch: iteration === record.iteration,
    record: { recoveryId: record.id, evidence, references: [], blocked: [],
      reason: 'Reuse verified task-owned references and original attempt budgets. Finish the retained iteration before new quality repairs.' } };
}
