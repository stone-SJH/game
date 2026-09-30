import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, hashFile, hashValue, readJson, localPath } from './modeling-io.mjs';

export async function readWorkspaceEpoch(workspace) {
  const pointer = await readJson(path.join(workspace, 'state-v2/current.json'));
  if (!pointer) return null;
  const file = await localPath(workspace, pointer.path, { existing: true });
  if (await hashFile(file) !== pointer.sha256) throw Object.assign(new Error('Execution epoch manifest changed'), { kind: 'INTEGRITY_ERROR' });
  const epoch = await readJson(file, null, 64 * 1024 * 1024);
  if (epoch.protocol !== 2 || epoch.status !== 'VERIFIED') throw Object.assign(new Error('Execution epoch is not verified'), { kind: 'TOOLCHAIN_CHANGED' });
  return epoch;
}

export async function compatiblePin(file, before, target) {
  let current = path.dirname(file);
  while (path.dirname(current) !== current) {
    if (path.basename(current) === 'modeling-state') {
      const workspace = path.dirname(current), epoch = await readWorkspaceEpoch(workspace);
      const relative = path.relative(workspace, file).split(path.sep).join('/');
      const binding = epoch?.pins?.[relative];
      return Boolean(binding && binding.before === hashValue(before) && binding.after === hashValue(target));
    }
    current = path.dirname(current);
  }
  return false;
}

// The controller revision is the budget identity. A monotonically allocated
// display sequence prevents legacy numerical stage filenames from colliding.
export function usesLegacyModelingBudget(epoch, revisionId) {
  return Boolean(revisionId && epoch?.branches?.some(branch =>
    branch.budgetMode !== 'revision' && branch.revisionIds.includes(revisionId)));
}

export async function modelingIteration(workspace, job, iteration) {
  if (!job.revisionId) return iteration; // Legacy controller remains supported.
  const epoch = await readWorkspaceEpoch(workspace);
  if (usesLegacyModelingBudget(epoch, job.revisionId)) return iteration;
  const file = path.join(workspace, 'state-v2/revisions.json');
  const state = await readJson(file) || { protocol: 2, next: 100000, revisions: {} };
  const prior = state.revisions[job.revisionId];
  if (!prior) {
    state.revisions[job.revisionId] = { first: state.next, runIds: [job.runId], budgetGrant: job.budgetGrant || job.payload?.budgetGrant || null };
    state.next += 1000;
  } else if (!prior.runIds.includes(job.runId)) prior.runIds.push(job.runId);
  if (iteration >= 1000) throw Object.assign(new Error('Revision iteration budget exceeded'), { kind: 'ITERATION_BOUNDARY_INVALID' });
  await atomicJson(file, state);
  return state.revisions[job.revisionId].first + iteration - 1;
}
