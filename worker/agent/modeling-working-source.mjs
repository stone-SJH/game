import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicJson, hashFile, localPath, readJson } from './modeling-io.mjs';

// One editable entry per asset; evidence continues to name immutable revisions.
export async function workingSource(project, candidate) {
  const source = candidate?.files?.find(file => file.path.endsWith('/source.blend') && !file.path.includes('/blockout/'));
  if (!source) return null;
  const original = await localPath(project, source.path, { existing: true });
  if (await hashFile(original) !== source.sha256) throw Object.assign(new Error('Candidate source changed'), { kind: 'INTEGRITY_ERROR' });
  const relative = `art/working/${candidate.assetId}/source.blend`, destination = await localPath(project, relative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const actual = await hashFile(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const previous = await readJson(path.join(path.dirname(destination), 'current.json'));
  if (actual && actual !== previous?.sha256 && actual !== source.sha256) throw Object.assign(new Error('Editable source has unrecorded changes; preserve them before adopting a new candidate'), { kind: 'INTEGRITY_ERROR' });
  if (actual !== source.sha256) {
    const temp = `${destination}.${crypto.randomUUID()}.tmp`;
    await fs.copyFile(original, temp, fs.constants.COPYFILE_EXCL);
    if (await hashFile(temp) !== source.sha256) throw Object.assign(new Error('Source changed during working-file update'), { kind: 'INTEGRITY_ERROR' });
    await fs.rename(temp, destination);
  }
  await atomicJson(path.join(path.dirname(destination), 'current.json'), { protocol: 1, assetId: candidate.assetId, path: relative,
    origin: source.path, sha256: source.sha256, attemptId: candidate.attemptId, requirementsHash: candidate.requirementsHash });
  return relative;
}
