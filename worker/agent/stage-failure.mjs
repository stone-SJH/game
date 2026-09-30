import { throwIfStopped } from './modeling-io.mjs';
import { failureKind } from './service-recovery.mjs';

// Only verified safety/identity fences stop the workflow. A component's generic
// hardFailure flag is not authority to fail the whole production task.
export function isExecutionFence(error) {
  return error?.executionFence === true || error?.stopConfirmed === false ||
    error?.result?.stopConfirmed === false || error?.result?.canceled === true ||
    /^(?:INTEGRITY_ERROR|STOP_UNCONFIRMED|CONCURRENT_EXECUTION|INVALID_DEADLINE|ITERATION_BOUNDARY_INVALID|.*(?:POLICY_CHANGED|VERSION_CHANGED|TOOLCHAIN_CHANGED))$/.test(error?.kind || '');
}

export function throwIfExecutionFenced(error, signal) {
  throwIfStopped(error, signal);
  if (isExecutionFence(error)) throw error;
  const kind = failureKind(error);
  if (['RESOURCE_EXHAUSTED', 'SERVICE_TRANSIENT', 'SERVICE_CONFIGURATION'].includes(kind)) {
    error.kind = kind; throw error;
  }
}

export function stageIssue(stage, error) {
  return { stage, status: 'GAP', kind: error.kind || error.code || 'STAGE_UNAVAILABLE',
    reason: String(error.message || error).slice(0, 4000),
    ...(error.executionFile ? { executionFile: error.executionFile } : {}),
    ...(error.validationIssues ? { validationIssues: error.validationIssues } : {}) };
}
