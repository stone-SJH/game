import path from 'node:path';
import { atomicJson, hashValue, readJson } from './modeling-io.mjs';
import { verifyEvidence } from './modeling-execution.mjs';

export function createStageCache(workspace, job) {
  return async function cached(stage, inputs, operation) {
    const key = hashValue({ stage, inputs });
    const file = path.join(workspace, 'stage-cache', `${key}.json`);
    const previous = await readJson(file, null, 16 * 1024 * 1024);
    if (previous) {
      await verifyEvidence(previous.evidence);
      // Reuse has a new envelope; never rewrite the original run's report.
      return { ...previous.result, reusedEvidence: { taskId: job.taskId, revisionId: job.revisionId || null, runId: job.runId,
        originRunId: previous.runId, stageInputHash: key, evidenceFile: file } };
    }
    const result = await operation();
    await atomicJson(file, { protocol: 1, stageInputHash: key, runId: job.runId, revisionId: job.revisionId || null,
      result, evidence: result?.evidence || [] });
    return result;
  };
}
