import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

export function atomicJson(file, value) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

export function validId(id) {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(id ?? '')) throw new Error('Invalid job ID');
  return id;
}

export function newJobId(now = Date.now()) {
  return new Date(now).toISOString().replace(/[^0-9]/g, '').slice(0, 14) + '-' + crypto.randomUUID().slice(0, 8);
}

export function submitJob({ channel, files, timeoutSeconds = 120, id = newJobId(), createdAt = new Date().toISOString(), metadata = {} }) {
  validId(id);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 3600) throw new Error('Timeout must be 0..3600 (0 means no hard timeout)');
  const names = new Set();
  for (const file of files) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(file.name ?? '') || file.name.split('/').includes('..') || names.has(file.name.toLowerCase())) throw new Error('Invalid or duplicate payload path');
    if (!fs.statSync(file.source).isFile()) throw new Error('Payload must be a regular file');
    names.add(file.name.toLowerCase());
  }
  if (!names.has('job.ps1')) throw new Error('job.ps1 is missing');
  for (const name of ['inbox', 'payload', 'results', 'cancel']) fs.mkdirSync(path.join(channel, name), { recursive: true });
  const requestFile = path.join(channel, 'inbox', id + '.json');
  // A committed request is immutable. Recovery reuses its ID after a crash.
  if (fs.existsSync(requestFile)) return readJson(requestFile);
  if (timeoutSeconds === 0) {
    const heartbeatFile = path.join(channel, 'heartbeat.json');
    if (!fs.existsSync(heartbeatFile) || readJson(heartbeatFile).supportsUnlimitedTimeout !== true) {
      throw new Error('Unlimited jobs require a deployed worker advertising supportsUnlimitedTimeout=true.');
    }
  }
  const dir = path.join(channel, 'payload', id);
  fs.mkdirSync(dir, { recursive: true });
  const entries = files.map(file => {
    const sourceBytes = fs.readFileSync(file.source);
    const needsBom = file.name.endsWith('.ps1') && !sourceBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
    const bytes = needsBom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), sourceBytes]) : sourceBytes;
    const destination = path.join(dir, file.name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
    return { name: file.name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  });
  const request = {
    ...metadata, protocol: 1, id, expectedComputer: 'yahahagame0', timeoutSeconds, createdAt,
    expiresAt: new Date(Date.parse(createdAt) + 24 * 3600000).toISOString(), files: entries,
  };
  atomicJson(requestFile, request);
  return request;
}
