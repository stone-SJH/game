import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicJson, hashFile, hashValue, localPath, readJson } from './modeling-io.mjs';
import { modelingFailure, verifyEvidence } from './modeling-execution.mjs';
import { imageGenerationSettings, imageGenerationCredential } from './modeling-image-settings.mjs';

export function checkConceptPng(bytes) {
  if (bytes.length < 45 || bytes.length > 20 * 1024 * 1024 ||
      !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Invalid generated PNG.');
  let offset = 8, hasPixels = false, ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    if (offset + length + 12 > bytes.length) throw new Error('Truncated generated PNG.');
    if (type === 'IDAT' && length) hasPixels = true;
    offset += length + 12;
    if (type === 'IEND') { ended = length === 0 && offset === bytes.length; break; }
  }
  if (!hasPixels || !ended) throw new Error('Invalid generated PNG chunks.');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (width < 256 || height < 256 || width > 4096 || height > 4096) throw new Error('Generated image dimensions are outside the concept budget.');
  return { width, height };
}

export function createModelingImageProvider({ fetchImpl = globalThis.fetch, settings = imageGenerationSettings, credential = imageGenerationCredential } = {}) {
  return {
    async availability() {
      try { const config = await settings(); return { enabled: Boolean(config.endpoint && await credential(config)), model: 'gpt-image-2' }; }
      catch { return { enabled: false, model: 'gpt-image-2', reasonCode: 'image_router_unavailable' }; }
    },
    async generate({ project, directory, stateFile, prompt, requirementsHash, signal = new AbortController().signal, deadlineAt }) {
      signal.throwIfAborted();
      let config;
      try { config = await settings(); }
      catch { return { status: 'unavailable', reasonCode: 'image_router_unavailable' }; }
      const body = { model: 'gpt-image-2', prompt, n: 1,
        size: config.identity.size, quality: 'high', output_format: 'png' };
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32000) throw new Error('Invalid concept generation prompt.');
      const requestHash = hashValue({ body, requirementsHash, router: config.identity });
      const previous = await readJson(stateFile);
      if (previous && previous.requestHash !== requestHash) throw modelingFailure('INTEGRITY_ERROR', 'Image generation input or router changed.');
      if (previous?.status === 'ready') {
        await verifyEvidence([{ file: await localPath(project, previous.imageFile), sha256: previous.sha256 }]);
        return previous;
      }
      // The synchronous endpoint has no task query. Unknown paid submissions
      // stay consumed after process death/timeout; a resume never repeats them.
      if (previous) return { ...previous, status: 'unavailable', reasonCode: previous.reasonCode || 'image_submission_unknown' };
      let key;
      try { key = await credential(config); }
      catch { return { status: 'unavailable', reasonCode: 'image_router_unavailable' }; }
      if (!config.endpoint || !key) return { status: 'unavailable', reasonCode: 'image_router_unavailable' };
      const remaining = deadlineAt ? Date.parse(deadlineAt) - Date.now() : Infinity;
      if (!(remaining > 0)) return { status: 'unavailable', reasonCode: 'image_deadline_exhausted' };
      const timeoutMs = Math.min(config.identity.timeoutMs, remaining);
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      const imageFile = directory + '/concept.png', file = await localPath(project, imageFile);
      const record = { protocol: 1, requestHash, status: 'submission_intent', model: 'gpt-image-2', prompt,
        startedAt: new Date().toISOString(), timeoutMs };
      await atomicJson(stateFile, record);
      try {
        const response = await fetchImpl(config.endpoint, { method: 'POST', redirect: 'error', signal: bounded,
          headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error('Image API request failed.'), { reasonCode: 'image_http_' + response.status }); }
        const chunks = []; let size = 0;
        for await (const chunk of response.body || []) {
          size += chunk.length; if (size > 30 * 1024 * 1024) throw new Error('Image API response too large.');
          chunks.push(Buffer.from(chunk));
        }
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8')), encoded = result.data?.[0]?.b64_json;
        if (result.data?.length !== 1 || typeof encoded !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Image API did not return one base64 PNG.');
        const bytes = Buffer.from(encoded, 'base64'), dimensions = checkConceptPng(bytes);
        bounded.throwIfAborted();
        await fs.mkdir(path.dirname(file), { recursive: true });
        const temporary = file + '.' + crypto.randomUUID() + '.tmp';
        await fs.writeFile(temporary, bytes, { flag: 'wx' }); await fs.rename(temporary, file);
        const ready = { ...record, status: 'ready', imageFile, sha256: await hashFile(file), ...dimensions };
        await atomicJson(stateFile, ready); return ready;
      } catch (error) {
        signal.throwIfAborted();
        if (['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'EIO'].includes(error.code)) throw error;
        // Router error bodies and exception strings can contain credentials.
        const failed = { ...record, status: 'unavailable',
          reasonCode: bounded.aborted ? 'image_timeout' : error.reasonCode || 'image_response_unavailable' };
        await atomicJson(stateFile, failed); return failed;
      }
    },
  };
}
