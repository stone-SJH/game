import fs from 'node:fs/promises';
import { localPath, readJson } from './modeling-io.mjs';

export function engineeringEvidence(engineering, assetId) {
  if (!engineering) return null;
  const { playerCapsule, requirements, sources, unresolvedFacts } = engineering;
  return { playerCapsule, requirements, sources, unresolvedFacts,
    ...(assetId ? { asset: engineering.assets?.find(row => row.assetId === assetId) } : {}) };
}

// Supplemental pictures are author claims, never independent host captures.
export async function authorEvidence(project, directory) {
  const reports = {}, files = [], images = [];
  for (const name of ['build-report.json', 'self-check.json']) {
    const file = await localPath(project, `${directory}/${name}`);
    let value;
    try { value = await readJson(file, null, 128 * 1024); }
    catch (error) {
      if (!(error instanceof SyntaxError) && !/JSON exceeds size limit/.test(error.message)) throw error;
      value = { unavailable: 'Optional author report is malformed or exceeds 128 KiB; retained for internal repair.', diagnostic: error.message.slice(0, 500) };
    }
    if (value) { reports[name] = value; files.push(file); }
  }
  const root = await localPath(project, `${directory}/evidence`);
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }
  const selected = entries.filter(entry => /\.(png|jpe?g|webp)$/i.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (selected.length > 12) reports.supplementalImages = { omitted: selected.slice(12).map(entry => entry.name), reason: 'Only the first 12 supplemental images can be attached; use a contact sheet next iteration.' };
  for (const entry of selected.slice(0, 12)) {
    const relative = `${directory}/evidence/${entry.name}`;
    const file = await localPath(project, relative, { existing: true });
    if (!entry.isFile() || (await fs.stat(file)).size > 10 * 1024 * 1024) {
      (reports.invalidImages ||= []).push({ path: relative, reason: 'Optional image is not a regular file or exceeds 10 MiB; omitted from review.' });
      continue;
    }
    images.push(relative); files.push(file);
  }
  return { reports, images, files };
}
