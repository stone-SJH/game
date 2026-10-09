import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, hashValue, localPath } from './modeling-io.mjs';
import { readModelingState } from './modeling-state.mjs';
import { verifyEvidence } from './modeling-execution.mjs';
import { conceptSpecification } from './modeling-generation-input.mjs';

// A user dimension amendment may reuse a verified generated source, never a rejected
// prompt or another asset's generation. All technical and visual gates run again.
export async function retainedDimensionSource({ spec, stateRoot, taskState, project, revisionId }) {
  const record = await readJson(await localPath(project, 'plan/modeling-user-revision.json'));
  if (record?.status !== 'APPLIED' || record.revisionId !== revisionId || !record.approval?.approved) return null;
  const change = record.proposal.changes.find(row => row.assetId === spec.assetId && row.dimensionAmendment);
  const before = record.before.assets.find(row => row.assetId === spec.assetId);
  const applied = record.appliedPlan.assets.find(row => row.assetId === spec.assetId);
  if (!change || !before || hashValue(applied) !== hashValue(spec) || hashValue(before) === hashValue(spec) ||
      hashValue(conceptSpecification(before)) !== hashValue(conceptSpecification(spec))) return null;
  const original = await readJson(path.join(taskState, `user-revision-${record.identity}.json`));
  if (hashValue(original) !== hashValue(record)) throw Object.assign(new Error('Dimension source revision evidence changed.'), { kind: 'INTEGRITY_ERROR' });
  const candidates = [];
  for (const entry of await fs.readdir(stateRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{20}$/.test(entry.name)) continue;
    const file = path.join(stateRoot, entry.name, 'state.json'), state = await readModelingState(file);
    if (!state || hashValue(state.spec) !== hashValue(before) || state.route !== 'image_tripo_blender' ||
        state.pending && state.pending.phase !== 'ACCEPTED') continue;
    const source = state.accepted || state.bestCandidate;
    const directory = source?.directory || state.previousAttemptDirectory;
    const generation = source?.generation || Object.values(state.rounds || {}).filter(row => row.generatedBase && row.concept?.status === 'APPROVED')
      .sort((a, b) => (b.iteration || 0) - (a.iteration || 0)).map(row => ({ concept: row.concept, base: row.generatedBase }))[0];
    const sourcePath = directory && `${directory}/source.blend`;
    const sourceHash = source?.files?.find(row => row.path === sourcePath)?.sha256 || state.feedback?.sourceHash;
    if (!sourcePath || !sourceHash || !generation?.base?.modelFile || !generation?.concept?.evidence?.length) continue;
    await verifyEvidence([{ file: await localPath(project, sourcePath, { existing: true }), sha256: sourceHash },
      { file: await localPath(project, generation.base.modelFile, { existing: true }), sha256: generation.base.sha256 }, ...generation.concept.evidence]);
    candidates.push({ stateFile: file, directory, sourcePath, sourceHash, generation,
      revisionIdentity: record.identity, originRequirementsHash: state.requirementsHash, at: state.failures?.at(-1)?.at || '' });
  }
  return candidates.sort((a, b) => b.at.localeCompare(a.at))[0] || null;
}
