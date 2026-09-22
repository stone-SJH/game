import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAX_BYTES = 20 * 1024 * 1024;

async function verified(file, reference, signal) {
  const stat = await fsp.lstat(file).catch(() => null);
  if (!stat?.isFile() || stat.size !== reference.sizeBytes) return false;
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest('hex') === reference.sha256;
}

export async function materializeReferences({ references = [], project, downloadReference, signal }) {
  if (!Array.isArray(references)) throw new Error('Invalid reference manifest.');
  if (!references.length) return [];
  const seen = new Set(), counts = new Map();
  for (const item of references) {
    if (!item || !/^reference-[a-f0-9-]{36}$/.test(item.referenceId) || seen.has(item.referenceId) ||
        !Number.isInteger(item.sizeBytes) || item.sizeBytes < 0 || item.sizeBytes > MAX_BYTES ||
        !/^[a-f0-9]{64}$/.test(item.sha256) || typeof item.name !== 'string' ||
        !Number.isInteger(item.taskRevision) || item.taskRevision < 1) throw new Error('Invalid reference manifest.');
    seen.add(item.referenceId);
    const count = (counts.get(item.taskRevision) || 0) + 1;
    if (count > 5) throw new Error('At most 5 reference files are allowed per task revision.');
    counts.set(item.taskRevision, count);
  }
  const directory = path.join(project, 'references');
  await fsp.mkdir(directory, { recursive: true });
  const stat = await fsp.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fsp.realpath(directory) !== path.join(await fsp.realpath(project), 'references')) {
    throw new Error('Reference directory must be inside the task workspace.');
  }
  const files = [];
  for (const reference of references) {
    signal.throwIfAborted();
    // Keep a harmless extension for viewers; never use a supplied file name as a path.
    const extension = path.extname(reference.name).toLowerCase();
    const filename = reference.referenceId + (/^\.[a-z0-9]{1,12}$/.test(extension) ? extension : '');
    const target = path.join(directory, filename);
    if (!await verified(target, reference, signal)) {
      if (typeof downloadReference !== 'function') throw new Error('Reference download transport is unavailable.');
      const response = await downloadReference(reference);
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`Reference download failed (${response.status}): ${reference.name}`);
      }
      const temporary = await fsp.mkdtemp(path.join(directory, '.download-'));
      const partial = path.join(temporary, 'file');
      const hash = crypto.createHash('sha256'); let size = 0;
      try {
        await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, encoding, callback) {
          size += chunk.length;
          if (size > reference.sizeBytes || size > MAX_BYTES) return callback(new Error(`Reference size mismatch: ${reference.name}`));
          hash.update(chunk); callback(null, chunk);
        } }), fs.createWriteStream(partial, { flags: 'wx' }), { signal });
        if (size !== reference.sizeBytes || hash.digest('hex') !== reference.sha256) throw new Error(`Reference integrity check failed: ${reference.name}`);
        await fsp.rename(partial, target);
      } finally { await fsp.rm(temporary, { recursive: true, force: true }); }
    }
    files.push({ ...reference, localPath: `references/${filename}` });
  }
  return files;
}
