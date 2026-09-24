import path from 'node:path';
import { atomicJson, hashFile, hashValue, readJson, setting, throwIfStopped } from './modeling-io.mjs';

export const EXECUTION_POLICY_VERSION = 2;
export function modelingFailure(kind, message, extra = {}) {
  return Object.assign(new Error(message), { kind, hardFailure: true, ...extra });
}

export function failureRecord(error, stage, signal) {
  const result = error?.result || {};
  const stopped = error?.stopConfirmed ?? result.stopConfirmed ?? null;
  const kind = error?.kind || (stopped === false ? 'STOP_UNCONFIRMED' : signal?.aborted || result.canceled ? 'CANCELED' :
    result.timedOut ? `${stage}_TIMEOUT` : result.exitCode != null && result.exitCode !== 0 ? `${stage}_PROCESS_ERROR` : `${stage}_UNKNOWN`);
  return { kind, message: String(error?.message || error).slice(0, 4000), exitCode: result.exitCode ?? null,
    timedOut: Boolean(result.timedOut), canceled: Boolean(signal?.aborted || result.canceled), stopConfirmed: stopped };
}

export function executionPolicy(invocation = {}) {
  return { version: EXECUTION_POLICY_VERSION, model: process.env.MODELING_AGENT_MODEL || 'inherited',
    invocation: { command: invocation.command || null, argsHash: hashValue(invocation.args || []) }, nodeVersion: process.version,
    reasoning: { author: 'inherited; pinned runtime config', review: 'medium' },
    buildMs: setting('MODELING_BUILD_TIMEOUT_MS', 1800000), cleanupMs: setting('MODELING_CLEANUP_TIMEOUT_MS', 300000),
    reviewMs: setting('MODELING_EVALUATION_TIMEOUT_MS', 120000), reviewCalls: 3, technicalMs: 300000, technicalCalls: 2 };
}

export async function fileEvidence(files) {
  const rows = [];
  for (const file of [...new Set(files)]) rows.push({ file, sha256: await hashFile(file) });
  return rows;
}

export async function verifyEvidence(rows) {
  for (const row of rows || []) {
    let actual;
    try { actual = await hashFile(row.file); } catch { /* Missing evidence is an integrity failure, too. */ }
    if (actual !== row.sha256) throw modelingFailure('INTEGRITY_ERROR', `Frozen modeling evidence changed: ${row.file}`);
  }
}

// One owner per task; atomic replacement is the commit point. Calls are reserved before invoking tools.
// A STARTED record without a terminal result deliberately fences recovery: the worker must confirm
// shutdown externally. It is never safe to infer that an orphaned process stopped from elapsed time.
export function createExecutionStore(root, { signal, deadlineAt, now = Date.now } = {}) {
  const file = path.join(root, 'execution.json');
  let busy = false;
  const taskDeadline = deadlineAt ? Date.parse(deadlineAt) : Infinity;
  if (Number.isNaN(taskDeadline)) throw modelingFailure('INVALID_DEADLINE', 'Invalid modeling task deadline.');
  async function load() {
    const state = await readJson(file) || { protocol: 2, nextCall: 1, groups: {} };
    if (state.protocol !== 2) throw modelingFailure('EXECUTION_VERSION_CHANGED', 'Restore the original modeling execution release.');
    return state;
  }
  async function run({ key, stage, identity = {}, input = {}, evidence = [], maxCalls = 1, timeoutMs, totalMs = maxCalls * timeoutMs,
    retry = () => false, onReserved, exhaustedKind = 'VALIDATION_INFRASTRUCTURE_EXHAUSTED' }, invoke) {
    if (busy) throw modelingFailure('CONCURRENT_EXECUTION', 'Modeling execution store already has a writer.');
    busy = true;
    try {
      signal?.throwIfAborted();
      const state = await load();
      const id = hashValue(key), inputHash = hashValue({ input, evidence }), limits = { maxCalls, timeoutMs, totalMs };
      let group = state.groups[id];
      if (group && (group.inputHash !== inputHash || hashValue(group.limits) !== hashValue(limits))) {
        throw modelingFailure('INTEGRITY_ERROR', 'Modeling execution inputs or limits changed under an existing stage.');
      }
      if (!group) {
        group = state.groups[id] = { key, stage, identity, inputHash, evidence, limits,
          startedAt: now(), deadlineAt: Math.min(now() + totalMs, taskDeadline), calls: [] };
        await atomicJson(file, state);
      }
      const uncertain = group.calls.find(call => call.status === 'STARTED' || call.error?.stopConfirmed === false);
      if (uncertain) throw modelingFailure('STOP_UNCONFIRMED', `Unfinished modeling call ${uncertain.callId}; verify its process tree before recovery.`, { stopConfirmed: false });
      await verifyEvidence(evidence);
      if (group.completed) return group.result;
      // A fresh, non-aborted signal denotes host resumption. A confirmed canceled author call
      // consumed its attempt: report interruption without replaying it, so the pipeline can use
      // the next original author allowance. Validation may use only its remaining call/time budget.
      if (group.terminalError) {
        const failure = group.terminalError;
        if (failure.kind === 'CANCELED' && failure.stopConfirmed === true) {
          if (stage === 'AUTHOR') throw modelingFailure('AUTHOR_INTERRUPTED', 'Previously canceled author stopped; its attempt remains consumed.',
            { hardFailure: false, stopConfirmed: true, executionFile: file });
          if (['REVIEW', 'TECHNICAL', 'SOURCE_PREVIEW'].includes(stage)) {
            group.cancellationResumes ||= [];
            group.cancellationResumes.push({ at: now(), consumedCalls: group.calls.length, deadlineAt: group.deadlineAt });
            delete group.terminalError;
            await atomicJson(file, state);
          } else throw modelingFailure(failure.kind, failure.message, { executionFile: file });
        } else throw modelingFailure(failure.kind, failure.message, { executionFile: file });
      }
      while (group.calls.length < maxCalls && now() < Math.min(group.deadlineAt, taskDeadline)) {
        signal?.throwIfAborted();
        await verifyEvidence(evidence);
        const callId = `${stage.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-${state.nextCall++}`;
        const call = { callId, status: 'STARTED', startedAt: now(), timeoutMs: Math.min(timeoutMs, group.deadlineAt - now(), taskDeadline - now()) };
        group.calls.push(call);
        await atomicJson(file, state);
        // Fault-injection/observation runs after the durable reservation, before any tool is launched.
        if (onReserved) await onReserved(call);
        try {
          const value = await invoke({ ...call, previousError: group.calls.at(-2)?.error || null });
          signal?.throwIfAborted();
          await verifyEvidence(evidence);
          call.status = 'COMPLETED'; call.finishedAt = now(); call.stopConfirmed = true;
          group.completed = true; group.result = value ?? null;
          await atomicJson(file, state);
          return group.result;
        } catch (error) {
          call.status = 'FAILED'; call.finishedAt = now(); call.error = failureRecord(error, stage, signal);
          const canRetry = !signal?.aborted && !call.error.canceled && call.error.stopConfirmed !== false &&
            !['INTEGRITY_ERROR', 'ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EIO'].includes(error.kind || error.code) && retry(error);
          if (!canRetry) group.terminalError = call.error;
          await atomicJson(file, state);
          throwIfStopped(error, signal);
          if (!canRetry) throw error;
        }
      }
      throw modelingFailure(exhaustedKind, `${stage} exhausted its durable call/time budget; retained evidence: ${file}`, {
        executionFile: file, lastFailure: group.calls.at(-1)?.error || null });
    } finally { busy = false; }
  }
  async function assertSettled() {
    const state = await load();
    for (const group of Object.values(state.groups)) {
      const call = group.calls.find(c => c.status === 'STARTED' || c.error?.stopConfirmed === false);
      if (call) throw modelingFailure('STOP_UNCONFIRMED', `Unfinished modeling call ${call.callId}; verify its process tree before recovery.`, { stopConfirmed: false });
    }
  }
  return { file, run, snapshot: load, assertSettled };
}
