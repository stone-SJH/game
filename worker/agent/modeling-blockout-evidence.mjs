import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { atomicJson, hashFile, hashValue, localPath, readJson } from './modeling-io.mjs';
import { modelingFailure, verifyEvidence } from './modeling-execution.mjs';
import { contentStore } from './workspace-storage.mjs';

// The final author can clean its output directory. Keep independent bytes in host
// task state before launching it; a hash alone cannot recover a deleted checkpoint.
export async function preserveBlockoutEvidence({ project, stateRoot, attemptId, evidence }) {
  const directory = await localPath(stateRoot, `blockout-evidence/${hashValue(attemptId)}`);
  const rows = [];
  for (const row of evidence) {
    const relative = path.relative(project, row.file).replaceAll('\\', '/');
    const original = await localPath(project, relative, { existing: true });
    await verifyEvidence([{ ...row, file: original }]);
    rows.push({ path: relative, sha256: row.sha256 });
  }
  await fs.mkdir(directory, { recursive: true });
  const store = contentStore(path.dirname(project));
  for (const [index, row] of rows.entries()) {
    const original = await localPath(project, row.path, { existing: true });
    const retained = await store.put(original);
    if (retained.sha256 !== row.sha256) throw modelingFailure('INTEGRITY_ERROR', 'Blockout changed while retaining checkpoint');
    const backup = store.objectPath(retained.sha256);
    await verifyEvidence([{ file: backup, sha256: row.sha256 }, { file: original, sha256: row.sha256 }]);
  }
  const file = await localPath(directory, 'manifest.json');
  const manifest = { protocol: 2, attemptId, rows };
  const existing = await readJson(file);
  if (existing && hashValue(existing) !== hashValue(manifest)) {
    throw modelingFailure('INTEGRITY_ERROR', 'Blockout backup identity changed.');
  }
  if (!existing) await atomicJson(file, manifest);
  return { file, sha256: await hashFile(file) };
}

export async function verifyBlockoutEvidence({ project, stateRoot, evidence, snapshot }) {
  // Old pinned tasks retain their strict evidence contract; never invent backups.
  if (!snapshot) { await verifyEvidence(evidence); return []; }
  const file = await localPath(stateRoot, path.relative(stateRoot, snapshot.file));
  await verifyEvidence([{ file, sha256: snapshot.sha256 }]);
  const manifest = await readJson(file);
  const expected = evidence.map(row => ({ path: path.relative(project, row.file).replaceAll('\\', '/'), sha256: row.sha256 }));
  if (![1, 2].includes(manifest?.protocol) || hashValue(manifest.rows) !== hashValue(expected)) {
    throw modelingFailure('INTEGRITY_ERROR', 'Blockout backup does not match the frozen evidence.');
  }
  const directory = path.dirname(file), missing = [];
  // Check the entire backup and all surviving originals before writing anything.
  for (const [index, row] of manifest.rows.entries()) {
    const original = await localPath(project, row.path);
    const backup = manifest.protocol === 2 ? contentStore(path.dirname(project)).objectPath(row.sha256) : await localPath(directory, `${index}.blob`);
    await verifyEvidence([{ file: backup, sha256: row.sha256 }]);
    try { await fs.lstat(original); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.push({ original, backup, ...row });
      continue;
    }
    await verifyEvidence([{ file: original, sha256: row.sha256 }]);
  }
  if (missing.length) {
    // Persist intent before restoring so a crash cannot leave an unrecorded repair.
    const recoveryFile = await localPath(directory, 'recovery.json');
    const recovery = await readJson(recoveryFile, { protocol: 1, snapshot, restorations: [] });
    const restoration = { at: new Date().toISOString(), status: 'STARTED', files: missing.map(({ path, sha256 }) => ({ path, sha256 })) };
    recovery.restorations.push(restoration);
    await atomicJson(recoveryFile, recovery);
    for (const row of missing) {
      const original = await localPath(project, row.path);
      await fs.mkdir(path.dirname(original), { recursive: true });
      // Never overwrite a replacement created by a concurrent writer.
      try { await fs.copyFile(row.backup, original, constants.COPYFILE_EXCL); }
      catch (error) {
        if (error.code === 'EEXIST') throw modelingFailure('CONCURRENT_EXECUTION', 'Blockout evidence appeared during recovery; inspect its writer.', { cause: error });
        throw error;
      }
    }
    await verifyEvidence(evidence);
    restoration.status = 'RESTORED';
    await atomicJson(recoveryFile, recovery);
  }
  return missing.map(row => row.path);
}
