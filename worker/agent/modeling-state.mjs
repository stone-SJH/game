import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicJson, hashValue, localPath, readJson } from './modeling-io.mjs';
import { modelingFailure, verifyEvidence } from './modeling-execution.mjs';

const INDEX_LIMIT = 2 * 1024 * 1024;
const LEGACY_LIMIT = 64 * 1024 * 1024;
const PAYLOAD_LIMIT = 32 * 1024 * 1024;
const INLINE_LIMIT = 64 * 1024;

// Counters, phases and deadlines stay in the atomic index. Large evidence is
// retained in immutable content-addressed files, never truncated or reset.
export async function readModelingState(file) {
  const stored = await readJson(file, null, LEGACY_LIMIT);
  if (!stored || stored.protocol === 2) return stored;
  if (stored.protocol !== 3 || stored.storage !== 'modeling-state-payloads-v1') {
    throw modelingFailure('EXECUTION_VERSION_CHANGED', 'Unsupported modeling state storage. Restore its pinned release.');
  }
  const { storage, payloads, ...state } = stored;
  if (!payloads || typeof payloads !== 'object' || Array.isArray(payloads)) {
    throw modelingFailure('INTEGRITY_ERROR', 'Missing modeling state payload index.');
  }
  state.protocol = 2;
  for (const [key, ref] of Object.entries(payloads || {})) {
    if (['__proto__', 'constructor', 'prototype', 'protocol', 'storage', 'payloads'].includes(key) || Object.hasOwn(state, key) || !/^[a-f0-9]{64}$/.test(ref?.sha256 || '')) {
      throw modelingFailure('INTEGRITY_ERROR', 'Invalid modeling state payload index.');
    }
    const source = await localPath(path.dirname(file), ref.path);
    await verifyEvidence([{ file: source, sha256: ref.sha256 }]);
    state[key] = await readJson(source, null, PAYLOAD_LIMIT);
  }
  return state;
}

export async function writeModelingState(file, state) {
  if (state.protocol !== 2) throw modelingFailure('EXECUTION_VERSION_CHANGED', 'Cannot rewrite an unknown modeling state version.');
  const index = { ...state, protocol: 3, storage: 'modeling-state-payloads-v1', payloads: {} };
  for (const [key, value] of Object.entries(state)) {
    const serialized = JSON.stringify(value, null, 2) + '\n';
    const bytes = Buffer.byteLength(serialized);
    if (bytes <= INLINE_LIMIT) continue;
    if (bytes > PAYLOAD_LIMIT) throw modelingFailure('MODELING_STATE_PAYLOAD_TOO_LARGE', 'Retained ' + key + ' needs ' + bytes + ' bytes; limit ' + PAYLOAD_LIMIT + '.', { file, bytes, limit: PAYLOAD_LIMIT, hardFailure: false });
    const relative = 'payloads/' + hashValue(value) + '.json', target = await localPath(path.dirname(file), relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try { await fs.stat(target); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await atomicJson(target, value); }
    const expected = crypto.createHash('sha256').update(serialized).digest('hex');
    await verifyEvidence([{ file: target, sha256: expected }]);
    index.payloads[key] = { path: relative, sha256: expected, bytes };
    delete index[key];
  }
  const bytes = Buffer.byteLength(JSON.stringify(index, null, 2) + '\n');
  if (bytes > INDEX_LIMIT) throw modelingFailure('MODELING_STATE_INDEX_TOO_LARGE', 'Modeling state index needs ' + bytes + ' bytes; limit ' + INDEX_LIMIT + '.', { file, bytes, limit: INDEX_LIMIT, hardFailure: false });
  await atomicJson(file, index);
}

// Handoffs carry concise history; the complete feedback remains in the state
// payloads and original validation reports. Snapshot the array, never alias it.
export function modelingFailureSummary(failures = [], stateFile) {
  return failures.map(({ feedback, ...failure }) => ({ ...failure,
    ...(feedback === undefined ? {} : { feedbackEvidence: { stateFile, retained: true } }) }));
}
