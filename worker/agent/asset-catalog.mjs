import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, hashFile, localPath, readJson } from './modeling-io.mjs';

export async function registerModelingAsset(project, entry) {
  const file = await localPath(project, 'provenance/modeling-catalog.json');
  const previous = await readJson(file, { assets: [] });
  const assets = Array.isArray(previous.assets) ? previous.assets : [];
  await atomicJson(file, { protocol: 1, assets: [entry, ...assets.filter(asset => asset.path !== entry.path)].slice(0, 300) });
}

// Only registered, licensed sources are eligible. Other workspaces are never crawled.
export async function buildAssetCatalog(project, spec = null) {
  const files = ['provenance/modeling-catalog.json', 'provenance/asset-manifest.json'];
  const assets = [], seen = new Set();
  for (const relative of files) {
    let manifest;
    try { manifest = await readJson(await localPath(project, relative)); } catch { continue; }
    for (const entry of (Array.isArray(manifest?.assets) ? manifest.assets : []).slice(0, 300)) {
      if (typeof entry.path !== 'string' || !/\.(blend|glb|fbx)$/i.test(entry.path) || !entry.license || !entry.source || seen.has(entry.path)) continue;
      try {
        const file = await localPath(project, entry.path, { existing: true });
        if (!(await fs.stat(file)).isFile()) continue;
        const sha256 = await hashFile(file);
        if (entry.sha256 && entry.sha256 !== sha256) continue;
        const previewImages = [];
        for (const preview of (Array.isArray(entry.previewImages) ? entry.previewImages : []).slice(0, 4)) {
          try {
            const image = await localPath(project, preview, { existing: true });
            if (/\.(png|jpe?g|webp)$/i.test(image) && (await fs.stat(image)).size <= 10 * 1024 * 1024) previewImages.push(preview);
          } catch { /* No visual evidence means reuse cannot be accepted. */ }
        }
        const assetId = `source-${sha256.slice(0, 20)}`;
        if (assets.some(asset => asset.assetId === assetId)) continue;
        seen.add(entry.path);
        assets.push({ assetId, path: entry.path, sha256, source: String(entry.source).slice(0, 600), license: String(entry.license).slice(0, 600),
          description: String(entry.description || entry.role || entry.path).slice(0, 1200), previewImages,
          metadata: entry.modelingMetadata || null });
      } catch { /* Ineligible or unreadable source; new-build paths remain available. */ }
    }
  }
  if (spec) {
    const terms = `${spec.assetId} ${spec.description}`.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(term => term.length > 2);
    const rank = item => terms.filter(term => `${item.path} ${item.description}`.toLowerCase().includes(term)).length;
    assets.sort((a, b) => rank(b) - rank(a) || a.path.localeCompare(b.path));
  }
  return assets.slice(0, 3);
}
