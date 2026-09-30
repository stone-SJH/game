import fs from 'node:fs/promises';
import path from 'node:path';
import { repositoryRoot, hashFile } from './modeling-io.mjs';
import { runCommand } from './process-runner.mjs';

export async function progressPreview(workspace, source, sha256, signal) {
  if (process.platform !== 'win32' || !/\.(png|jpe?g)$/i.test(source) || (await fs.stat(source)).size < 1024 * 1024) return { file: source, sha256 };
  const directory = path.join(workspace, 'previews-v2'), file = path.join(directory, `${sha256}-jpeg1280-v1.jpg`);
  if (await fs.stat(file).catch(() => null)) return { file, sha256: await hashFile(file) };
  await fs.mkdir(directory, { recursive: true });
  const temp = file + '.tmp';
  const result = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(repositoryRoot, 'worker/tools/make-preview.ps1'), '-Source', source, '-Destination', temp], { timeoutMs: 15000, signal });
  if (result.exitCode !== 0 || result.error || !result.stopConfirmed) {
    if (!result.stopConfirmed) throw Object.assign(new Error('Preview process stop unconfirmed'), { stopConfirmed: false });
    await fs.rm(temp, { force: true }); return { file: source, sha256 };
  }
  if (await hashFile(source) !== sha256) { await fs.rm(temp, { force: true }); return { file: source, sha256: await hashFile(source) }; }
  await fs.rename(temp, file);
  return { file, sha256: await hashFile(file) };
}
