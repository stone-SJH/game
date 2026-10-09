import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicJson, hashFile, hashValue, localPath, readJson } from './modeling-io.mjs';
import { modelingFailure, verifyEvidence } from './modeling-execution.mjs';
import { imageGenerationSettings, imageGenerationCredential } from './modeling-image-settings.mjs';
import { recoverService } from './service-recovery.mjs';

const transientHttp = reason => /^image_http_(408|429|500|502|503|504)$/.test(reason || '');
const inputRejectionCodes = new Set(['moderation_blocked', 'content_policy_violation']);

// Retain bounded, classified evidence, never arbitrary router messages or keys.
async function imageHttpEvidence(response) {
  const chunks = []; let bytes = 0, truncated = false;
  try {
    for await (const chunk of response.body || []) {
      const buffer = Buffer.from(chunk), remaining = 16384 - bytes;
      chunks.push(buffer.subarray(0, remaining)); bytes += Math.min(buffer.length, remaining);
      if (buffer.length > remaining) { truncated = true; break; }
    }
  } catch { truncated = true; }
  const body = Buffer.concat(chunks);
  let value;
  try { if (!truncated) value = JSON.parse(body.toString('utf8')); } catch { /* Non-JSON errors still retain a digest. */ }
  const code = value?.error?.code;
  const requestId = response.headers.get('x-request-id');
  return { httpStatus: response.status, bodySha256: crypto.createHash('sha256').update(body).digest('hex'),
    retainedBytes: bytes, truncated,
    code: inputRejectionCodes.has(code) ? code : 'unclassified',
    ...(typeof requestId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId) ? { requestId } : {}) };
}

function imageServiceError(record, requestStateFile) {
  const reason = record.reasonCode || 'image_submission_unknown';
  if (record.responseEvidence?.httpStatus === 400 && inputRejectionCodes.has(record.responseEvidence.code)) {
    return Object.assign(new Error(`Concept image input rejected by upstream content review (${record.responseEvidence.code}). Retain the evidence; do not automatically resubmit this input.`), {
      kind: 'IMAGE_INPUT_REJECTED', requiresInputChange: true, retrySafe: false, stopConfirmed: true,
      reasonCode: reason, responseEvidence: record.responseEvidence, requestStateFile,
    });
  }
  return Object.assign(new Error(`Concept image service unavailable: ${reason}. Retain the request and evidence.`), {
    kind: /^image_http_4\d\d$/.test(reason) && !transientHttp(reason) ? 'SERVICE_CONFIGURATION' : 'SERVICE_TRANSIENT',
    retrySafe: transientHttp(reason), stopConfirmed: true, reasonCode: reason,
    retryAfterMs: record.retryAfterMs || 0,
  });
}

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

export function createModelingImageProvider({ fetchImpl = globalThis.fetch, settings = imageGenerationSettings, credential = imageGenerationCredential,
  recoveryOptions = {} } = {}) {
  return {
    async availability() {
      try { const config = await settings(); return { enabled: Boolean(config.endpoint && await credential(config)), model: 'gpt-image-2' }; }
      catch { return { enabled: false, model: 'gpt-image-2', reasonCode: 'image_router_unavailable' }; }
    },
    async generate({ project, directory, stateFile, prompt, requirementsHash, signal = new AbortController().signal, deadlineAt, onWaiting }) {
      signal.throwIfAborted();
      let config;
      try { config = await settings(); }
      catch { return { status: 'unavailable', reasonCode: 'image_router_unavailable' }; }
      const body = { model: 'gpt-image-2', prompt, n: 1,
        size: config.identity.size, quality: 'high', output_format: 'png' };
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32000) throw new Error('Invalid concept generation prompt.');
      // Content refusals survive new revisions, asset metadata and router settings.
      // This provider submits text only; reference descriptions are part of prompt.
      const rejectionFile = path.join(path.dirname(project), 'modeling-state/image-rejections', hashValue({ prompt: prompt.trim() }) + '.json');
      const rejected = await readJson(rejectionFile);
      if (rejected) {
        const original = await localPath(path.dirname(project), rejected.requestStatePath, { existing: true });
        await verifyEvidence([{ file: original, sha256: rejected.sha256 }]);
        const record = await readJson(original);
        if (record.prompt?.trim() !== prompt.trim() || !inputRejectionCodes.has(record.responseEvidence?.code)) throw modelingFailure('INTEGRITY_ERROR', 'Retained input rejection changed.');
        throw imageServiceError(record, original);
      }
      async function retainRejection(record) {
        if (record.responseEvidence?.httpStatus === 400 && inputRejectionCodes.has(record.responseEvidence.code)) {
          const requestStatePath = path.relative(path.dirname(project), stateFile);
          await localPath(path.dirname(project), requestStatePath, { existing: true });
          await atomicJson(rejectionFile, { requestStatePath, sha256: await hashFile(stateFile) });
        }
      }
      const requestHash = hashValue({ body, requirementsHash, router: config.identity });
      let previous = await readJson(stateFile);
      if (previous && previous.requestHash !== requestHash) throw modelingFailure('INTEGRITY_ERROR', 'Image generation input or router changed.');
      if (previous?.status === 'ready') {
        await verifyEvidence([{ file: await localPath(project, previous.imageFile), sha256: previous.sha256 }]);
        return previous;
      }
      // A received retryable HTTP rejection can recover inside this operation.
      // A lost response/timeout has unknown billing status and is never resubmitted.
      if (previous && !transientHttp(previous.reasonCode)) { await retainRejection(previous); throw imageServiceError(previous, stateFile); }
      let key;
      try { key = await credential(config); }
      catch { return { status: 'unavailable', reasonCode: 'image_router_unavailable' }; }
      if (!config.endpoint || !key) return { status: 'unavailable', reasonCode: 'image_router_unavailable' };
      const imageFile = directory + '/concept.png', file = await localPath(project, imageFile);
      return recoverService(stateFile + '.service.json', async () => {
        const remaining = deadlineAt ? Date.parse(deadlineAt) - Date.now() : Infinity;
        if (!(remaining > 0)) throw imageServiceError({ reasonCode: 'image_deadline_exhausted' });
        const timeoutMs = Math.min(config.identity.timeoutMs, remaining);
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
        const history = previous ? [...(previous.history || []), { status: previous.status, reasonCode: previous.reasonCode,
          startedAt: previous.startedAt, timeoutMs: previous.timeoutMs,
          ...(previous.responseEvidence ? { responseEvidence: previous.responseEvidence } : {}) }] : [];
        const record = { protocol: 1, requestHash, status: 'submission_intent', model: 'gpt-image-2', prompt,
          startedAt: new Date().toISOString(), timeoutMs, history };
        await atomicJson(stateFile, record);
        try {
          const response = await fetchImpl(config.endpoint, { method: 'POST', redirect: 'error', signal: bounded,
            headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          if (!response.ok) {
            const retryAfter = response.headers.get('retry-after');
            const retryAfterMs = /^\d+(?:\.\d+)?$/.test(retryAfter || '') ? Number(retryAfter) * 1000
              : Math.max(0, Date.parse(retryAfter) - Date.now()) || 0;
            const responseEvidence = await imageHttpEvidence(response);
            throw Object.assign(new Error('Image API request failed.'), { reasonCode: 'image_http_' + response.status, retryAfterMs, responseEvidence });
          }
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
            reasonCode: bounded.aborted ? 'image_timeout' : error.reasonCode || 'image_response_unavailable',
            retryAfterMs: error.retryAfterMs || 0,
            ...(error.responseEvidence ? { responseEvidence: error.responseEvidence } : {}) };
          await atomicJson(stateFile, failed); previous = failed;
          await retainRejection(failed);
          throw imageServiceError(failed, stateFile);
        }
      }, { ...recoveryOptions, signal, deadlineAt, onWaiting });
    },
  };
}
