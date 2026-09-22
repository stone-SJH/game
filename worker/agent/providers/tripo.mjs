import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson, hashFile, hashValue, localPath, readJson, repositoryRoot, setting } from '../modeling-io.mjs';

// This worker uses a China-region key and endpoint. Do not fail over across regions.
const API = 'https://openapi.tripo3d.com/v3';
const unavailable = (reasonCode, extra = {}) => ({ status: 'unavailable', provider: 'tripo', reasonCode, fallbackRoute: 'blender_direct', ...extra });
const failure = (reasonCode, extra = {}) => Object.assign(new Error(reasonCode), { reasonCode, ...extra });

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
  requestTimeoutMs = setting('TRIPO_REQUEST_TIMEOUT_MS', 20000), maxWaitMs = setting('TRIPO_MAX_WAIT_MS', 480000),
  pollMs = setting('TRIPO_POLL_MS', 3000), maxBytes = 150 * 1024 * 1024,
  model = process.env.TRIPO_MODEL || 'v3.1-20260211', maxGenerations = setting('TRIPO_MAX_GENERATIONS_PER_RUN', 1, 0, 20),
} = {}) {
  async function request(endpoint, { key, method = 'GET', body, signal }) {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]);
    try {
      const response = await fetchImpl(`${API}${endpoint}`, { method, redirect: 'error', signal: bounded,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      let value;
      try { value = JSON.parse((await limitedBody(response, 1024 * 1024)).toString('utf8')); }
      catch { throw failure(classify(response.status), { httpStatus: response.status }); }
      if (!response.ok || value.code !== 0) throw failure(classify(response.status, value.code), { httpStatus: response.status, providerCode: Number.isInteger(value.code) ? value.code : null });
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
    async generate({ project, directory, stateFile, ledgerFile, assetId, prompt, requirementsHash, signal = new AbortController().signal, deadlineAt } = {}) {
      signal.throwIfAborted();
      const keyInfo = await readTripoKey({ repoRoot, keyFile });
      if (!keyInfo.enabled) return unavailable(keyInfo.reasonCode);
      const root = await localPath(project, directory);
      await fs.mkdir(root, { recursive: true });
      const file = await localPath(project, `${directory}/tripo-model.glb`);
      const body = { prompt: String(prompt || '').slice(0, 1024), model, texture: true, pbr: true, face_limit: 30000 };
      const requestHash = hashValue({ body, assetId, requirementsHash });
      let state = await readJson(stateFile);
      if (state && state.requestHash !== requestHash) throw new Error('Provider state does not match immutable modeling inputs.');
      if (state?.status === 'unavailable') return state;
      if (state?.status === 'ready') {
        try { if (await hashFile(file) === state.sha256) return state; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (state && state.providerRegion !== 'cn') return unavailable('provider_region_unknown', { taskId: state.taskId || null });
      if (state && !state.taskId) return unavailable('submission_unknown', { submissionUnknown: true });
      const remaining = deadlineAt ? Date.parse(deadlineAt) - Date.now() : Infinity;
      if (remaining < maxWaitMs + 120000) return unavailable('insufficient_fallback_time');
      const totalSignal = AbortSignal.any([signal, AbortSignal.timeout(maxWaitMs)]);
      const save = async value => { state = { protocol: 1, requestHash, assetId, providerRegion: 'cn', apiVersion: 'v3', model, ...state, ...value }; await atomicJson(stateFile, state); return state; };
      try {
        if (!state?.taskId) {
          const ledger = await readJson(ledgerFile, { submissions: 0, disabled: false });
          if (ledger.disabled || ledger.submissions >= maxGenerations) return unavailable(ledger.reasonCode || 'generation_budget_exhausted');
          // Reserve before the request. Crash/timeout never permits a second paid POST.
          await save({ status: 'submission_intent', creditsConsumed: null });
          await atomicJson(ledgerFile, { ...ledger, submissions: ledger.submissions + 1 });
          const created = await request('/generation/text-to-model', { key: keyInfo.key, method: 'POST', body, signal: totalSignal });
          if (typeof created?.task_id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(created.task_id)) throw failure('missing_task_id');
          await save({ status: 'waiting', taskId: created.task_id });
        }
        let detail;
        while (true) {
          totalSignal.throwIfAborted();
          detail = await request(`/tasks/${encodeURIComponent(state.taskId)}`, { key: keyInfo.key, signal: totalSignal });
          if (detail?.status === 'success') break;
          if (['failed', 'cancelled'].includes(detail?.status)) throw failure('task_failed', { providerCode: Number.isInteger(detail.error_code) ? detail.error_code : null });
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
        await atomicJson(ledgerFile, { ...ledger, disabled: true, reasonCode });
        return await save(unavailable(reasonCode, { taskId: state?.taskId || null, submissionUnknown: !state?.taskId,
          httpStatus: error.httpStatus || null, providerCode: error.providerCode || null, creditsConsumed: null }));
      }
    },
  };
}
