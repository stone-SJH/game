import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson, hashFile, hashValue, localPath, readJson, repositoryRoot, setting } from '../modeling-io.mjs';
import { modelingFailure, verifyEvidence } from '../modeling-execution.mjs';
import { checkConceptPng } from '../modeling-image-provider.mjs';

// This worker uses a China-region key and endpoint. Do not fail over across regions.
const API = 'https://openapi.tripo3d.com/v3';
const unavailable = (reasonCode, extra = {}) => ({ status: 'unavailable', provider: 'tripo', reasonCode, fallbackRoute: 'blender_direct', ...extra });
const failure = (reasonCode, extra = {}) => Object.assign(new Error(reasonCode), { reasonCode, ...extra });
export const canResumeTripoImageTask = state => Boolean(state?.taskId && !state.requiresInputChange && (['waiting', 'ready'].includes(state.status) ||
  (state.status === 'unavailable' && !['task_failed', 'provider_region_unknown'].includes(state.reasonCode))));

export async function readTripoKey({ repoRoot = repositoryRoot, keyFile = process.env.TRIPO_API_KEY_FILE } = {}) {
  const file = keyFile ? path.resolve(keyFile) : path.join(repoRoot, 'tripo.txt');
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 4096) return { enabled: false, reasonCode: 'key_file_invalid' };
    const key = (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '').trim();
    if (!key) return { enabled: false, reasonCode: 'key_file_empty' };
    if (/\s|[\x00-\x1f\x7f]/.test(key)) return { enabled: false, reasonCode: 'key_file_invalid' };
    return { enabled: true, key };
  } catch (error) { return { enabled: false, reasonCode: error.code === 'ENOENT' ? 'key_file_missing' : 'key_file_unreadable' }; }
}

export async function tripoAvailability(options) {
  const { enabled, reasonCode } = await readTripoKey(options);
  return { enabled, reasonCode: reasonCode || null, provider: 'tripo', model: process.env.TRIPO_MODEL || 'v3.1-20260211' };
}

function classify(httpStatus, code) {
  if (httpStatus === 400 && code === 2008) return 'content_policy_rejected';
  if (code === 2010) return 'insufficient_credits';
  if (httpStatus === 401 || code === 1000 || code === 1001) return 'authentication';
  if (httpStatus === 403) return 'forbidden';
  if (httpStatus === 429 || code === 2000) return 'rate_limited';
  if (httpStatus >= 500) return 'service_unavailable';
  return 'provider_contract_error';
}

async function limitedBody(response, maxBytes) {
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw failure('response_too_large'); }
  if (!response.body) throw failure('empty_response');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw failure('response_too_large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function createTripoProvider({ repoRoot = repositoryRoot, keyFile, fetchImpl = globalThis.fetch,
  requestTimeoutMs = setting('TRIPO_REQUEST_TIMEOUT_MS', 120000), maxWaitMs = setting('TRIPO_MAX_WAIT_MS', 1200000),
  pollMs = setting('TRIPO_POLL_MS', 3000), maxBytes = 150 * 1024 * 1024,
  model = process.env.TRIPO_MODEL || 'v3.1-20260211', maxGenerations = setting('TRIPO_MAX_GENERATIONS_PER_RUN', 1, 0, 20),
  maxImageGenerations = setting('TRIPO_MAX_IMAGE_GENERATIONS_PER_ITERATION', 8, 0, 30),
} = {}) {
  async function request(endpoint, { key, method = 'GET', body, form, signal }) {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]);
    try {
      const response = await fetchImpl(`${API}${endpoint}`, { method, redirect: 'error', signal: bounded,
        headers: { Authorization: 'Bearer ' + key, ...(form ? {} : { 'Content-Type': 'application/json' }) },
        ...(form ? { body: form } : body ? { body: JSON.stringify(body) } : {}) });
      let value;
      try { value = JSON.parse((await limitedBody(response, 1024 * 1024)).toString('utf8')); }
      catch { throw failure(classify(response.status), { httpStatus: response.status }); }
      if (!response.ok || value.code !== 0) {
        const trace = response.headers.get('x-tripo-trace-id') || value.request_id;
        const requestId = typeof trace === 'string' && /^(?:req_[a-zA-Z0-9_-]{1,100}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(trace) ? trace : null;
        throw failure(classify(response.status, value.code), { httpStatus: response.status,
          providerCode: Number.isInteger(value.code) ? value.code : null, ...(requestId ? { requestId } : {}) });
      }
      return value.data;
    } catch (error) {
      signal.throwIfAborted();
      throw error.reasonCode ? error : failure(bounded.aborted ? 'request_timeout' : 'network_error');
    }
  }

  async function download(url, file, signal) {
    // Only provider-owned/CDN domains. Never forward the API Authorization header.
    for (let redirects = 0; redirects <= 3; redirects++) {
      let parsed;
      try { parsed = new URL(url); } catch { throw failure('invalid_download_url'); }
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port ||
          !/(^|\.)(tripo3d\.(ai|com)|tripo-data\.(s3\.[a-z0-9-]+\.amazonaws\.com|oss-[a-z0-9-]+\.aliyuncs\.com))$/.test(parsed.hostname)) throw failure('invalid_download_host');
      let response;
      try { response = await fetchImpl(parsed.href, { redirect: 'manual', signal }); }
      catch { signal.throwIfAborted(); throw failure('download_network_error'); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw failure('download_redirect_invalid');
        url = new URL(location, parsed).href; continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw failure('download_http_error', { httpStatus: response.status }); }
      const bytes = await limitedBody(response, maxBytes);
      if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw failure('invalid_glb');
      await fs.writeFile(`${file}.partial`, bytes);
      await fs.rename(`${file}.partial`, file);
      return;
    }
    throw failure('too_many_redirects');
  }

  return {
    availability: () => tripoAvailability({ repoRoot, keyFile }),
    async balance({ signal = new AbortController().signal } = {}) {
      const key = await readTripoKey({ repoRoot, keyFile });
      if (!key.enabled) return unavailable(key.reasonCode);
      try {
        const result = await request('/account/balance', { key: key.key, signal });
        if (!Number.isFinite(result?.balance)) return unavailable('invalid_balance');
        return result.balance > 0 ? { status: 'ready', balance: result.balance } : unavailable('insufficient_credits');
      } catch (error) { signal.throwIfAborted(); return unavailable(error.reasonCode || 'provider_error'); }
    },
    async generate({ project, directory, stateFile, ledgerFile, rejectionDirectory, assetId, prompt, requirementsHash, image, resumePolling = false, signal = new AbortController().signal, deadlineAt } = {}) {
      signal.throwIfAborted();
      let imageBytes;
      if (image) {
        if (!image.approval?.file || !image.approval.sha256) throw modelingFailure('INTEGRITY_ERROR', 'Image-to-3D requires retained independent approval.');
        const inputFile = await localPath(project, image.path, { existing: true });
        const approvalFile = await localPath(project, image.approval.file, { existing: true });
        await verifyEvidence([{ file: inputFile, sha256: image.sha256 }, { file: approvalFile, sha256: image.approval.sha256 }]);
        const approval = await readJson(approvalFile);
        if (approval.imageHash !== image.sha256 || approval.status !== 'APPROVED') throw modelingFailure('INTEGRITY_ERROR', 'Image-to-3D approval does not identify the submitted image.');
        if (!approval.review?.file || !approval.review.sha256) throw modelingFailure('INTEGRITY_ERROR', 'Image-to-3D approval has no reviewed evidence.');
        const reviewFile = await localPath(project, approval.review.file, { existing: true });
        await verifyEvidence([{ file: reviewFile, sha256: approval.review.sha256 }]);
        const review = await readJson(reviewFile);
        if (review.criteria?.length !== 5 || new Set(review.criteria.map(item => item.criterion)).size !== 5 ||
            review.criteria.some(item => item.status !== 'PASS')) throw modelingFailure('INTEGRITY_ERROR', 'Image-to-3D concept has not passed independent review.');
        if ((await fs.stat(inputFile)).size > 20 * 1024 * 1024) throw new Error('Concept image is too large.');
        imageBytes = await fs.readFile(inputFile); checkConceptPng(imageBytes);
      }
      const keyInfo = await readTripoKey({ repoRoot, keyFile });
      const root = await localPath(project, directory);
      await fs.mkdir(root, { recursive: true });
      const file = await localPath(project, `${directory}/tripo-model.glb`);
      const body = image ? { model, texture: true, pbr: true, texture_quality: 'detailed', face_limit: 30000 } :
        { prompt: String(prompt || '').slice(0, 1024), model, texture: true, pbr: true, face_limit: 30000 };
      const inputIdentity = hashValue({ provider: 'tripo', assetId, body, ...(image ? { imageHash: image.sha256 } : {}) });
      const rejectedFile = path.join(rejectionDirectory || path.dirname(stateFile), 'rejected-tripo-input-' + inputIdentity + '.json');
      const effectiveInput = { prompt: body.prompt?.trim() || null, imageHash: image?.sha256 || null };
      const effectiveRejectionFile = path.join(path.dirname(project), 'modeling-state/provider-rejections', 'tripo-' + hashValue(effectiveInput) + '.json');
      const effectiveRejected = await readJson(effectiveRejectionFile);
      if (effectiveRejected) {
        const actual = { prompt: effectiveRejected.inputReview?.prompt?.trim() || null, imageHash: effectiveRejected.inputReview?.image?.sha256 || null };
        if (!effectiveRejected.requiresInputChange || effectiveRejected.responseEvidence?.providerCode !== 2008 || hashValue(actual) !== hashValue(effectiveInput)) {
          throw modelingFailure('INTEGRITY_ERROR', 'Retained effective Tripo input rejection changed.');
        }
        return { ...effectiveRejected, cachedRejection: true };
      }
      const rejected = await readJson(rejectedFile);
      if (rejected) {
        if (rejected.inputReview?.inputIdentity !== inputIdentity || !rejected.requiresInputChange) throw modelingFailure('INTEGRITY_ERROR', 'Tripo rejection identity changed.');
        await atomicJson(effectiveRejectionFile, rejected);
        return { ...rejected, cachedRejection: true };
      }
      const requestHash = hashValue({ body, assetId, requirementsHash, ...(image ? { imageHash: image.sha256, approval: image.approval } : {}) });
      let state = await readJson(stateFile);
      if (state && state.requestHash !== requestHash) throw modelingFailure('INTEGRITY_ERROR', 'Provider state does not match immutable modeling inputs.');
      if (state?.status === 'unavailable' && (state.responseEvidence?.providerCode === 2008 && state.requiresInputChange ||
          state.providerCode === 2008 && (state.httpStatus === 400 || state.reasonCode === 'task_failed'))) {
        const responseEvidence = state.responseEvidence || { httpStatus: state.httpStatus || null, providerCode: 2008 };
        const retained = { ...state, ...unavailable('content_policy_rejected'), kind: 'PROVIDER_INPUT_REJECTED', requiresInputChange: true,
          fallbackRoute: null, responseEvidence, inputReview: state.inputReview || { provider: 'tripo', inputIdentity, requestHash,
            prompt: body.prompt || null, image: image ? { path: image.path, sha256: image.sha256 } : null, response: responseEvidence, exactTriggerKnown: false } };
        await atomicJson(rejectedFile, retained); // Add derived classification; never rewrite the historical request.
        await atomicJson(effectiveRejectionFile, retained);
        return retained;
      }
      if (state?.status === 'unavailable' && !(image && resumePolling && canResumeTripoImageTask(state))) return state;
      if (state?.status === 'ready') {
        try { if (await hashFile(file) === state.sha256) return state; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (state && state.providerRegion !== 'cn') return unavailable('provider_region_unknown', { taskId: state.taskId || null });
      if (state && !state.taskId) return unavailable('submission_unknown', { submissionUnknown: true });
      if (!keyInfo.enabled) return unavailable(keyInfo.reasonCode);
      const remaining = deadlineAt ? Date.parse(deadlineAt) - Date.now() : Infinity;
      if (remaining < maxWaitMs + 120000) return unavailable('insufficient_fallback_time');
      const totalSignal = AbortSignal.any([signal, AbortSignal.timeout(maxWaitMs)]);
      const save = async value => { state = { protocol: 1, requestHash, assetId, providerRegion: 'cn', apiVersion: 'v3', model, ...state, ...value }; await atomicJson(stateFile, state); return state; };
      try {
        if (!state?.taskId) {
          const ledger = await readJson(ledgerFile, { submissions: 0, disabled: false });
          if (ledger.disabled || ledger.submissions >= (image ? maxImageGenerations : maxGenerations)) return unavailable(ledger.reasonCode || 'generation_budget_exhausted');
          // Reserve before the request. Crash/timeout never permits a second paid POST.
          await save({ status: 'submission_intent', creditsConsumed: null });
          await atomicJson(ledgerFile, { ...ledger, submissions: ledger.submissions + 1 });
          let token;
          if (image) {
            const form = new FormData(); form.append('file', new Blob([imageBytes], { type: 'image/png' }), 'concept.png');
            const uploaded = await request('/files', { key: keyInfo.key, method: 'POST', form, signal: totalSignal });
            if (typeof uploaded?.file_token !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(uploaded.file_token)) throw failure('missing_file_token');
            token = uploaded.file_token;
          }
          const created = await request(image ? '/generation/image-to-model' : '/generation/text-to-model',
            { key: keyInfo.key, method: 'POST', body: image ? { ...body, input: token } : body, signal: totalSignal });
          if (typeof created?.task_id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(created.task_id)) throw failure('missing_task_id');
          await save({ status: 'waiting', taskId: created.task_id });
        }
        let detail;
        while (true) {
          totalSignal.throwIfAborted();
          detail = await request(`/tasks/${encodeURIComponent(state.taskId)}`, { key: keyInfo.key, signal: totalSignal });
          if (detail?.status === 'success') break;
          if (['failed', 'cancelled'].includes(detail?.status)) throw failure(detail.error_code === 2008 ? 'content_policy_rejected' : 'task_failed', { providerCode: Number.isInteger(detail.error_code) ? detail.error_code : null });
          if (!['queued', 'running'].includes(detail?.status)) throw failure('unknown_task_status');
          await delay(pollMs, undefined, { signal: totalSignal });
        }
        if (typeof detail.output?.model_url !== 'string') throw failure('missing_model_url');
        await download(detail.output.model_url, file, totalSignal);
        return await save({ status: 'ready', provider: 'tripo', model, modelFile: `${directory}/tripo-model.glb`, sha256: await hashFile(file),
          creditsConsumed: Number.isFinite(detail.credits_consumed) ? detail.credits_consumed : null });
      } catch (error) {
        signal.throwIfAborted();
        if (['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'EIO'].includes(error.code)) throw error;
        const reasonCode = totalSignal.aborted ? 'provider_timeout' : error.reasonCode || 'provider_error';
        const ledger = await readJson(ledgerFile, { submissions: 0 });
        if (reasonCode === 'content_policy_rejected') {
          const responseEvidence = { httpStatus: error.httpStatus || null, providerCode: 2008, ...(error.requestId ? { requestId: error.requestId } : {}) };
          const result = await save(unavailable(reasonCode, { kind: 'PROVIDER_INPUT_REJECTED', requiresInputChange: true,
            fallbackRoute: null,
            taskId: state?.taskId || null, submissionUnknown: false, creditsConsumed: null, responseEvidence,
            inputReview: { provider: 'tripo', inputIdentity, requestHash, prompt: body.prompt || null,
              image: image ? { path: image.path, sha256: image.sha256 } : null, response: responseEvidence, exactTriggerKnown: false } }));
          // A rejected asset does not disable generation of unrelated assets or refund a reservation.
          await atomicJson(rejectedFile, result);
          await atomicJson(effectiveRejectionFile, result);
          return result;
        }
        await atomicJson(ledgerFile, { ...ledger, disabled: true, reasonCode });
        return await save(unavailable(reasonCode, { taskId: state?.taskId || null, submissionUnknown: !state?.taskId,
          httpStatus: error.httpStatus || null, providerCode: error.providerCode || null, creditsConsumed: null }));
      }
    },
  };
}
