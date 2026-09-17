import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

export function optionalJson(file) {
  try { return readJson(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function atomicJson(file, value) {
  ensureDir(path.dirname(file));
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

export function appendJsonLine(file, value) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(value) + '\n', 'utf8');
}

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function sha256Json(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function id(value, label = 'id') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

export function newId(prefix, now = Date.now()) {
  return `${prefix}-${new Date(now).toISOString().replace(/[^0-9]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
}

export function timestamp(now = Date.now()) {
  return new Date(now).toISOString();
}
