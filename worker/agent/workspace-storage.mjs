import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicJson, hashFile, hashValue, localPath, readJson } from './modeling-io.mjs';

const GiB = 1024 ** 3;
const indexes = new Map();
const statSignature = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
export async function requireSpace(directory, additionalBytes, { reserveBytes = 20 * GiB, statfs = fs.statfs } = {}) {
  const stat = await statfs(directory);
  const available = Number(stat.bavail) * Number(stat.bsize);
  if (available < additionalBytes + reserveBytes) throw Object.assign(new Error(`Insufficient disk budget: need ${additionalBytes + reserveBytes} bytes, available ${available}`),
    { kind: 'RESOURCE_EXHAUSTED', code: 'ENOSPC', available, additionalBytes, reserveBytes });
  return { available, additionalBytes, reserveBytes };
}

export async function walkFiles(root, include = () => true) {
  const rows = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = path.relative(root, path.join(directory, entry.name)).split(path.sep).join('/');
      if (!include(relative, entry)) continue;
      const file = await localPath(root, relative, { existing: true });
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) rows.push({ path: relative, file, size: (await fs.stat(file)).size });
    }
  }
  await visit(root);
  return rows.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

// Immutable objects never share writable inodes with the project. The manifest is
// committed only after every object has been durably written and verified.
export function contentStore(workspace, { reserveBytes = 20 * GiB } = {}) {
  const root = path.join(workspace, 'storage-v2');
  const indexFile = path.join(root, 'hash-index.json');
  if (!indexes.has(root)) indexes.set(root, readJson(indexFile, {}, 32 * 1024 * 1024));
  const objectPath = sha => {
    if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error('Invalid content digest');
    return path.join(root, 'objects', sha.slice(0, 2), sha);
  };
  async function put(file) {
    const index = await indexes.get(root), before = await fs.stat(file), signature = statSignature(await fs.stat(file, { bigint: true }));
    const cached = index[file];
    if (cached?.signature === signature) {
      const object = await fs.stat(objectPath(cached.sha256), { bigint: true }).catch(() => null);
      if (object && statSignature(object) === cached.objectSignature) return { sha256: cached.sha256, size: before.size };
    }
    const sha256 = await hashFile(file), destination = objectPath(sha256);
    if (statSignature(await fs.stat(file, { bigint: true })) !== signature) throw Object.assign(new Error('Source changed while hashing checkpoint'), { kind: 'INTEGRITY_ERROR' });
    const remember = async () => { index[file] = { signature, sha256, objectSignature: statSignature(await fs.stat(destination, { bigint: true })) }; };
    try {
      const stat = await fs.stat(destination);
      if (stat.size !== before.size || await hashFile(destination) !== sha256) throw Object.assign(new Error('Corrupt immutable object'), { kind: 'INTEGRITY_ERROR' });
      await remember(); return { sha256, size: before.size };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await requireSpace(root, before.size, { reserveBytes });
    const temp = `${destination}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.copyFile(file, temp, fs.constants.COPYFILE_EXCL);
      if (await hashFile(temp) !== sha256) throw Object.assign(new Error('Source changed during checkpoint'), { kind: 'INTEGRITY_ERROR' });
      const handle = await fs.open(temp, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temp, destination);
    } finally { await fs.rm(temp, { force: true }); }
    await remember(); return { sha256, size: before.size };
  }
  async function snapshot(directory, include) {
    const files = [];
    for (const row of await walkFiles(directory, include)) files.push({ path: row.path, ...await put(row.file) });
    const id = hashValue(files), manifest = { protocol: 2, id, files };
    await atomicJson(path.join(root, 'manifests', `${id}.json`), manifest);
    await atomicJson(indexFile, await indexes.get(root));
    return manifest;
  }
  async function restore(manifest, directory, predicate = () => true) {
    if (manifest.status === 'EXPIRED') throw Object.assign(new Error('This unpinned historical checkpoint has expired'), { kind: 'SNAPSHOT_EXPIRED' });
    if (hashValue(manifest.files) !== manifest.id) throw Object.assign(new Error('Snapshot manifest changed'), { kind: 'INTEGRITY_ERROR' });
    for (const row of manifest.files.filter(predicate)) {
      const source = objectPath(row.sha256);
      if (await hashFile(source) !== row.sha256) throw Object.assign(new Error('Snapshot object changed'), { kind: 'INTEGRITY_ERROR' });
      const target = await localPath(directory, row.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      try {
        if (await hashFile(target) === row.sha256) continue;
        throw Object.assign(new Error(`Frozen modeling evidence changed: ${target}`), { kind: 'INTEGRITY_ERROR' });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await requireSpace(root, row.size, { reserveBytes });
      const temp = `${target}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.copyFile(source, temp, fs.constants.COPYFILE_EXCL);
        if (await hashFile(temp) !== row.sha256) throw Object.assign(new Error('Checkpoint changed during materialization'), { kind: 'INTEGRITY_ERROR' });
        const handle = await fs.open(temp, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temp, target);
      } finally { await fs.rm(temp, { force: true }); }
    }
    return directory;
  }
  return { root, put, snapshot, restore, objectPath, manifest: id => readJson(path.join(root, 'manifests', `${id}.json`), null, 64 * 1024 * 1024) };
}

export const packageEntry = relative => !relative.split('/').some(part => part === 'Saved' || part.startsWith('.yahahagame-package-'));
export const checkpointEntry = relative => !relative.split('/').some(part => ['Intermediate', 'DerivedDataCache', '.git', '.codex', '__pycache__', 'node_modules', 'Saved'].includes(part));
