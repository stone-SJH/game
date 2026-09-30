import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, hashFile, hashValue, readJson } from './modeling-io.mjs';
import { isExecutionFence } from './stage-failure.mjs';
import { failureKind } from './service-recovery.mjs';
import { contentStore } from './workspace-storage.mjs';

function throwIfExecutionFenced(error, signal) {
  signal?.throwIfAborted();
  if (isExecutionFence(error) || ['RESOURCE_EXHAUSTED', 'SERVICE_CONFIGURATION'].includes(failureKind(error))) throw error;
}

export async function awaitArtifactPublication(publisher, { signal, retryDelayMs = 10000, maxWaitMs = 900000, onPending = async () => {} } = {}) {
  const started = Date.now();
  while (publisher.summary().requiredPending > 0) {
    signal?.throwIfAborted();
    if (Date.now() - started >= maxWaitMs) throw Object.assign(new Error('Artifact service unavailable; pending publications retained for recovery.'), { kind: 'SERVICE_TRANSIENT' });
    await onPending(publisher.summary());
    await delay(retryDelayMs, undefined, { signal });
    await publisher.flush({ requiredOnly: true });
  }
  return publisher.summary();
}

// Publication is an independent, resumable delivery operation. Its availability
// must not relabel production quality or discard a retained iteration.
export async function createArtifactPublisher({ file, upload, signal, workspace = path.dirname(file), retryDelayMs = 1000, maxAttempts = 3 }) {
  const store = contentStore(workspace);
  const state = await readJson(file, null, 64 * 1024 * 1024) || { protocol: 1, items: {} };
  let queue = Promise.resolve();
  const serialized = operation => {
    const next = queue.then(operation); queue = next.catch(() => {}); return next;
  };
  async function attempt(item) {
    if (item.status === 'PUBLISHED') return item.artifactId;
    for (let n = 0; n < maxAttempts; n++) {
      signal?.throwIfAborted();
      item.attempts++; item.status = 'PENDING';
      await atomicJson(file, state);
      try {
        const sha256 = await hashFile(item.path);
        if (item.sha256 && sha256 !== item.sha256) throw new Error('Pending publication source changed; retain the original evidence and republish its snapshot.');
        item.sha256 ||= sha256;
        item.artifactId = await upload(item.name, item.path, item.contentType, item.options);
        item.status = 'PUBLISHED'; delete item.lastError;
        await atomicJson(file, state);
        return item.artifactId;
      } catch (error) {
        throwIfExecutionFenced(error, signal);
        item.lastError = String(error.message).slice(0, 4000);
        await atomicJson(file, state);
        if (n + 1 < maxAttempts) await delay(retryDelayMs, undefined, { signal });
      }
    }
    return null;
  }
  return {
    publish: (name, source, contentType, options = {}) => serialized(async () => {
      const { required = false, ...uploadOptions } = options;
      let sha256, lastError;
      try { sha256 = await hashFile(source); }
      catch (error) { throwIfExecutionFenced(error, signal); lastError = String(error.message); }
      const key = hashValue({ name, sha256: sha256 || null });
      if (sha256 && !state.items[key]) {
        try {
          const object = await store.put(source);
          if (object.sha256 !== sha256) throw Object.assign(new Error('Artifact changed during retention'), { kind: 'INTEGRITY_ERROR' });
          const retained = store.objectPath(sha256);
          state.items[key] = { name, source, path: retained, sha256, contentType, options: uploadOptions, required, attempts: 0, status: 'PENDING' };
        } catch (error) { throwIfExecutionFenced(error, signal); throw error; }
      }
      const item = state.items[key] ||= { name, source, path: source, sha256: sha256 || null, contentType, options: uploadOptions, required, attempts: 0, status: 'PENDING', lastError };
      item.required ||= required;
      return attempt(item);
    }),
    flush: ({ requiredOnly = false } = {}) => serialized(async () => {
      for (const item of Object.values(state.items)) if (item.status !== 'PUBLISHED' && (!requiredOnly || item.required)) await attempt(item);
    }),
    summary: () => ({ status: Object.values(state.items).some(item => item.status !== 'PUBLISHED') ? 'PENDING' : 'PUBLISHED',
      requiredPending: Object.values(state.items).filter(item => item.required && item.status !== 'PUBLISHED').length,
      manifest: file, pending: Object.values(state.items).filter(item => item.status !== 'PUBLISHED').map(({ name, path, lastError, attempts, required }) => ({ name, path, lastError, attempts, required })) }),
    artifactIds: () => Object.values(state.items).filter(item => item.status === 'PUBLISHED').map(item => item.artifactId),
  };
}
