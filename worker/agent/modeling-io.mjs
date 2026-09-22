import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
export const hashValue = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function localPath(root, relative, { existing = false } = {}) {
  if (typeof relative !== 'string' || !relative || /[\x00-\x1f:]/.test(relative) || path.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === '..')) throw new Error('Invalid modeling workspace path.');
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  const tail = path.relative(base, target);
  if (!tail || tail.startsWith('..') || path.isAbsolute(tail)) throw new Error('Modeling path must be inside its workspace.');
  let current = base;
  for (const component of [null, ...tail.split(path.sep)]) {
    if (component !== null) current = path.join(current, component);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Modeling paths cannot traverse links or junctions.'); }
    catch (error) { if (error.code !== 'ENOENT' || existing) throw error; }
  }
  return target;
}

export async function readJson(file, fallback = null, limit = 2 * 1024 * 1024) {
  try {
    if ((await fs.stat(file)).size > limit) throw new Error('Modeling JSON exceeds size limit.');
    return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await fs.rename(temporary, file);
}

export function setting(name, fallback, min = 1, max = 86400000) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be ${min}..${max}.`);
  return value;
}

export function throwIfStopped(error, signal) {
  signal?.throwIfAborted();
  if (error?.stopConfirmed === false || error?.result?.stopConfirmed === false || error?.result?.canceled) throw error;
}

export function agentEnvironment(base = process.env) {
  return Object.fromEntries(Object.entries(base).filter(([key]) => !/^(?:TRIPO_|WORKER_TOKEN$)/i.test(key)));
}

export async function recordAuthorRecipe(project, directory, receipt) {
  const steps = [];
  for (const call of receipt.calls || []) {
    if (call.tool !== 'blender_run_python' || !call.scriptFile) continue;
    if (await hashFile(await localPath(project,call.scriptFile,{existing:true})) !== call.scriptHash) throw new Error('Executed Blender script changed.');
    steps.push({script:call.scriptFile,sha256:call.scriptHash,exitCode:call.exitCode,startedAt:call.startedAt,finishedAt:call.finishedAt});
  }
  if (!steps.some(step=>step.exitCode===0)) throw new Error('Missing executed modeling recipe.');
  const file = `${directory}/execution-recipe.json`;
  await atomicJson(await localPath(project,file),{protocol:2,lifecycle:'A fresh Blender process for each step, in recorded order. Paths refer to this retained workspace.',
    source:`${directory}/source.blend`,sourceHash:await hashFile(await localPath(project,`${directory}/source.blend`,{existing:true})),steps});
  return [file,...new Set(steps.map(step=>step.script))];
}
