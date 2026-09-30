import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, hashFile, hashValue, readJson, localPath } from './modeling-io.mjs';
import { walkFiles } from './workspace-storage.mjs';
import { workspaceLock } from './workspace-lock.mjs';

// Manifest roots, pending uploads and explicit milestone/rollback pins are roots.
// Never sweep projects, legacy rounds, execution ledgers or mutable engine caches.
export async function planContentGc(workspace, { now = Date.now(), graceMs = 7 * 86400000 } = {}) {
  const root = path.join(workspace, 'storage-v2'), marked = new Set(), sources = [];
  const known = new Map(), pinned = new Set();
  const production = path.join(workspace, 'production-state');
  if (await fs.stat(production).catch(() => null)) for (const row of await walkFiles(production)) {
    if (path.basename(row.file) !== 'iterations.json') continue;
    const ledger = await readJson(row.file, null, 64 * 1024 * 1024);
    sources.push({ path: row.file, digest: hashValue(ledger) });
    const rounds = ledger.rounds || [];
    for (const round of rounds) for (const id of [round.snapshotId, round.packageDigest]) if (id) known.set(id, round);
    for (const round of [...rounds.slice(-2), ...(ledger.best ? [ledger.best.delivery] : []), ...rounds.filter(row => row.qualityAccepted)]) {
      if (round.snapshotId) pinned.add(round.snapshotId);
      if (round.packageDigest) pinned.add(round.packageDigest);
    }
  }
  const pointer = await readJson(path.join(workspace, 'state-v2/current.json'));
  if (pointer) {
    const epoch = await readJson(await localPath(workspace, pointer.path, { existing: true }), null, 64 * 1024 * 1024);
    if (epoch?.rollbackSnapshot) pinned.add(epoch.rollbackSnapshot);
    sources.push({ path: 'epoch', digest: hashValue({ pointer, epoch }) });
  }
  const epochs = path.join(workspace, 'state-v2/epochs');
  if (await fs.stat(epochs).catch(() => null)) for (const row of await walkFiles(epochs)) {
    if (path.basename(row.file) !== 'epoch.json') continue;
    const epoch = await readJson(row.file, null, 64 * 1024 * 1024);
    if (epoch?.status === 'VERIFIED' && epoch.rollbackSnapshot) pinned.add(epoch.rollbackSnapshot);
    sources.push({ path: row.file, digest: hashValue(epoch) });
  }
  const expired = [];
  const pinDirectory = path.join(root, 'pins');
  if (await fs.stat(pinDirectory).catch(() => null)) for (const row of await walkFiles(pinDirectory)) {
    if (!row.path.endsWith('.json')) continue;
    const pin = await readJson(row.file);
    for (const id of [pin?.snapshotId, pin?.packageDigest, ...(pin?.snapshots || [])]) if (id) pinned.add(id);
  }
  const mark = value => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.sha256 === 'string') marked.add(value.sha256);
    for (const item of Object.values(value)) if (typeof item === 'object') mark(item);
  };
  for (const directory of ['manifests', 'pins']) {
    const dir = path.join(root, directory);
    if (!await fs.stat(dir).catch(() => null)) continue;
    for (const row of await walkFiles(dir)) {
      if (!row.path.endsWith('.json')) continue;
      const value = await readJson(row.file, null, 64 * 1024 * 1024);
      if (directory === 'manifests' && known.has(value.id) && !pinned.has(value.id) && (await fs.stat(row.file)).mtimeMs <= now - graceMs) expired.push({ path: path.relative(workspace, row.file), id: value.id });
      else mark(value);
      sources.push({ path: row.file, digest: hashValue(value) });
    }
  }
  const runs = path.join(workspace, 'runs');
  const modeling = path.join(workspace, 'modeling-state');
  if (await fs.stat(modeling).catch(() => null)) for (const row of await walkFiles(modeling)) {
    if (!row.path.endsWith('.json')) continue;
    const value = await readJson(row.file, null, 64 * 1024 * 1024); mark(value);
    sources.push({ path: row.file, digest: hashValue(value) });
  }
  if (await fs.stat(runs).catch(() => null)) for (const entry of await fs.readdir(runs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = await localPath(workspace, `runs/${entry.name}/artifact-publication.json`);
    const state = await readJson(file, null, 64 * 1024 * 1024);
    if (state) { for (const item of Object.values(state.items || {})) if (item.status !== 'PUBLISHED') mark(item); sources.push({ path: file, digest: hashValue(state) }); }
  }
  const objects = path.join(root, 'objects'), candidates = [];
  if (await fs.stat(objects).catch(() => null)) for (const row of await walkFiles(objects)) {
    const stat = await fs.stat(row.file);
    if (stat.mtimeMs <= now - graceMs && !marked.has(path.basename(row.file))) candidates.push({ path: path.relative(workspace, row.file), size: stat.size });
  }
  const expiredIds = new Set(expired.map(row => row.id));
  const expiredPackages = new Set([...expiredIds].filter(id => known.get(id)?.packageDigest === id));
  // Materialized package/view/archive bytes are caches of verified content.
  // Reclaim only known expired payloads, or unreferenced hashes after grace.
  for (const area of ['storage-v2/views', 'storage-v2/archives', 'play', 'previews-v2']) {
    const directory = path.join(workspace, area);
    if (!await fs.stat(directory).catch(() => null)) continue;
    for (const row of await walkFiles(directory)) {
      const stat = await fs.stat(row.file);
      if (stat.mtimeMs > now - graceMs) continue;
      const first = row.path.split('/')[0];
      const disposable = area.endsWith('/views') ? /^[a-f0-9]{64}$/.test(first) && !marked.has(first)
        : area.endsWith('/archives') ? expiredPackages.has(first.split('.')[0])
        : area === 'play' ? [...expiredPackages].some(id => first === id.slice(0, 20))
        : /^[a-f0-9]{64}-jpeg1280-v1\.jpg$/.test(first);
      // Pending outbox references to previews are protected by their content hash.
      if (disposable && (area !== 'previews-v2' || !marked.has(await hashFile(row.file))))
        candidates.push({ path: path.relative(workspace, row.file), size: stat.size });
    }
  }
  return { protocol: 1, workspace, createdAt: now, rootsDigest: hashValue(sources), candidates, expiredSnapshots: expired,
    reclaimableBytes: candidates.reduce((n, row) => n + row.size, 0), policy: 'Seven-day grace; retain latest two, best, accepted, milestone and migration checkpoints. Legacy data requires explicit retirement.' };
}

export async function applyContentGc(workspace, expected) {
  const release = await workspaceLock(workspace, { operation: 'gc' });
  try {
  if (path.resolve(workspace) !== path.resolve(expected.workspace)) throw new Error('GC workspace mismatch');
  const live = await planContentGc(workspace, { now: expected.createdAt });
  if (hashValue(live) !== hashValue(expected)) throw new Error('GC references changed; create a fresh dry run');
  for (const row of live.expiredSnapshots) {
    const file = await localPath(workspace, row.path, { existing: true });
    await atomicJson(file, { protocol: 2, id: row.id, status: 'EXPIRED', expiredAt: new Date().toISOString(), files: [] });
  }
  let bytes = 0;
  for (const row of live.candidates) {
    const file = await localPath(workspace, row.path, { existing: true });
    if (!['storage-v2/objects', 'storage-v2/views', 'storage-v2/archives', 'play', 'previews-v2'].some(area => file.startsWith(path.join(path.resolve(workspace), area) + path.sep))) throw new Error('GC target escapes content caches');
    await fs.unlink(file); bytes += row.size;
  }
  return { deletedObjects: live.candidates.length, reclaimedBytes: bytes };
  } finally { await release(); }
}
