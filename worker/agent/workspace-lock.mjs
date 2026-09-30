import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export async function workspaceLock(workspace, owner) {
  const file = path.join(workspace, 'state-v2/storage.lock'), token = crypto.randomUUID();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const value = JSON.stringify({ token, owner, pid: process.pid, startedAt: new Date().toISOString() });
  try { await fs.writeFile(file, value, { flag: 'wx' }); }
  catch (error) {
    if (error.code === 'EEXIST') throw Object.assign(new Error('Workspace has an active or interrupted writer; verify the journal and process before recovery.'), { kind: 'CONCURRENT_EXECUTION', executionFence: true });
    throw error;
  }
  return async () => {
    if (await fs.readFile(file, 'utf8') !== value) throw Object.assign(new Error('Workspace writer lock changed'), { kind: 'INTEGRITY_ERROR' });
    await fs.unlink(file);
  };
}
