import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson, readJson } from './modeling-io.mjs';

export function failureKind(error) {
  const message = `${error?.message || ''}\n${error?.result?.stderr || ''}\n${error?.result?.stdout || ''}`;
  if (error?.stopConfirmed === false || error?.result?.stopConfirmed === false) return 'STOP_UNCONFIRMED';
  if (['RESOURCE_EXHAUSTED', 'SERVICE_TRANSIENT', 'SERVICE_CONFIGURATION'].includes(error?.kind)) return error.kind;
  if (['ENOSPC', 'EDQUOT', 'EROFS', 'EIO'].includes(error?.code) || /ENOSPC|no space left on device|disk full/i.test(message)) return 'RESOURCE_EXHAUSTED';
  const status = error?.status || error?.statusCode || Number(error?.upstreamAI?.code?.match(/^HTTP_(\d{3})$/)?.[1]);
  if ([401, 403, 404].includes(status) || /invalid_api_key|authentication failed|model_not_found|unsupported model/i.test(message)) return 'SERVICE_CONFIGURATION';
  if (['STREAM_DISCONNECTED', 'CONNECTION_RESET', 'REQUEST_TIMEOUT', 'DNS_ERROR', 'CONNECTION_REFUSED', 'REQUEST_SEND_FAILED'].includes(error?.upstreamAI?.code) ||
      [408, 429, 500, 502, 503, 504].includes(status) || /(?:HTTP|status|response|upstream|upload failed)[^\r\n]{0,40}\b(?:429|502|503|504)\b|ECONNRESET|ETIMEDOUT|EAI_AGAIN|overloaded|service unavailable|upstream.*error/i.test(message)) return 'SERVICE_TRANSIENT';
  return error?.kind || 'CONTENT_GAP';
}

// Durable service budgets are independent of content authoring/quality budgets.
export async function recoverService(file, invoke, { signal, deadlineAt, now = Date.now, wait = delay, maxWaitMs = 900000,
  onWaiting = async () => {} } = {}) {
  const state = await readJson(file) || { protocol: 1, failures: 0, waitedMs: 0, attempts: 0 };
  const deadline = deadlineAt ? Date.parse(deadlineAt) : Infinity;
  if (Number.isNaN(deadline)) throw Object.assign(new Error('Invalid service deadline'), { kind: 'INVALID_DEADLINE' });
  while (true) {
    signal?.throwIfAborted();
    if (state.nextRetryAt > now()) {
      const duration = state.nextRetryAt - now();
      if (state.waitedMs + duration > maxWaitMs || state.nextRetryAt >= deadline) throw Object.assign(new Error('Service retry budget exhausted; retain the current operation and outputs.'), { kind: 'SERVICE_TRANSIENT', serviceBudgetExhausted: true, stopConfirmed: true });
      state.waitedMs += duration; await atomicJson(file, state);
      await onWaiting({ phase: 'waiting_service', status: 'running', waitReason: state.lastError, nextRetryAt: new Date(state.nextRetryAt).toISOString() });
      await wait(duration, undefined, { signal });
    }
    if (now() >= deadline || state.exhausted) throw Object.assign(new Error('Service recovery deadline/budget exhausted'), { kind: 'SERVICE_TRANSIENT', serviceBudgetExhausted: true, stopConfirmed: true });
    state.attempts++; await atomicJson(file, state);
    try {
      const value = await invoke();
      state.failures = 0; state.nextRetryAt = null; delete state.lastError;
      await atomicJson(file, state); return value;
    } catch (error) {
      const kind = failureKind(error); error.kind = kind;
      if (kind !== 'SERVICE_TRANSIENT' || signal?.aborted || error.retrySafe === false) throw error;
      state.failures++; state.lastError = String(error.message).slice(0, 2000);
      const retryAfter = Number(error.retryAfterMs) || 0;
      const duration = Math.max(retryAfter, state.failures >= 3 ? 60000 : 5000 * 2 ** (state.failures - 1));
      state.nextRetryAt = now() + duration;
      state.exhausted = state.waitedMs + duration > maxWaitMs || state.nextRetryAt >= deadline;
      await atomicJson(file, state);
      if (state.exhausted) { error.serviceBudgetExhausted = true; throw error; }
    }
  }
}
