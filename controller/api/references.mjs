import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { id, problem } from './database.mjs';

export const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
export const MAX_REFERENCES = 5;

export function referenceMetadata(row) {
  return { referenceId: row.reference_id, name: row.name, contentType: row.content_type,
    sizeBytes: Number(row.size_bytes), sha256: row.sha256 };
}

export async function receiveReference(db, req, userId, root) {
  let name;
  try { name = decodeURIComponent(req.headers['x-file-name'] || ''); } catch { throw problem(400, 'Invalid file name.'); }
  if (!name || name.length > 240 || /[\x00-\x1f\x7f/\\]/.test(name) || ['.', '..'].includes(name)) throw problem(400, 'Invalid file name.');
  if (Number(req.headers['content-length']) > MAX_REFERENCE_BYTES) throw problem(413, 'Each reference file must be at most 20 MB.');
  const contentType = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(contentType)) throw problem(400, 'Invalid file content type.');
  const referenceId = id('reference');
  await fs.mkdir(root, { recursive: true });
  const target = path.join(root, referenceId), temp = `${target}.tmp`;
  let file, size = 0;
  const hash = crypto.createHash('sha256');
  try {
    file = await fs.open(temp, 'wx');
    // Keep the socket alive on a size rejection so the caller receives HTTP 413.
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > MAX_REFERENCE_BYTES) { req.resume(); throw problem(413, 'Each reference file must be at most 20 MB.'); }
      hash.update(chunk);
      await file.writeFile(chunk);
    }
    await file.close(); file = null;
    await fs.rename(temp, target);
    const row = (await db.query(`INSERT INTO task_references(reference_id,user_id,name,content_type,storage_path,sha256,size_bytes)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [referenceId, userId, name, contentType, target, hash.digest('hex'), size])).rows[0];
    return referenceMetadata(row);
  } catch (error) {
    await fs.rm(target, { force: true });
    throw error;
  } finally {
    await file?.close();
    await fs.rm(temp, { force: true });
  }
}

export async function selectedReferences(client, userId, value = [], taskRevision) {
  if (!Array.isArray(value) || value.length > MAX_REFERENCES || new Set(value).size !== value.length ||
      value.some(item => typeof item !== 'string' || !/^reference-[a-f0-9-]{36}$/.test(item))) {
    throw problem(400, 'Select at most 5 distinct uploaded reference files.');
  }
  if (!value.length) return [];
  const rows = (await client.query(`SELECT * FROM task_references WHERE reference_id=ANY($1::text[]) AND user_id=$2
    AND task_id IS NULL AND created_at>now()-interval '24 hours' ORDER BY reference_id FOR UPDATE`, [value, userId])).rows;
  if (rows.length !== value.length) throw problem(400, 'Reference files are unavailable, already attached, or expired. Please upload again.');
  return value.map(referenceId => ({ ...referenceMetadata(rows.find(row => row.reference_id === referenceId)), taskRevision }));
}

export async function bindReferences(client, references, taskId, revisionId) {
  if (references.length) await client.query('UPDATE task_references SET task_id=$2,revision_id=$3 WHERE reference_id=ANY($1::text[])',
    [references.map(item => item.referenceId), taskId, revisionId]);
}

export async function removePendingReference(db, userId, referenceId) {
  const result = await db.query('DELETE FROM task_references WHERE reference_id=$1 AND user_id=$2 AND task_id IS NULL RETURNING storage_path', [referenceId, userId]);
  for (const row of result.rows) await fs.rm(row.storage_path, { force: true });
}

export async function expirePendingReferences(db) {
  const result = await db.query("DELETE FROM task_references WHERE task_id IS NULL AND created_at<now()-interval '24 hours' RETURNING storage_path");
  for (const row of result.rows) await fs.rm(row.storage_path, { force: true });
}
