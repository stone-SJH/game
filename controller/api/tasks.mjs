import { digest, id, problem, transaction } from './database.mjs';

export const terminal = new Set(['COMPLETED', 'FAILED', 'CANCELED', 'EXPIRED']);
const ARTIFACT_PAGE_SIZE = 5;
const artifactPageCache = new Map();
const ARTIFACT_CACHE_TTL = 30_000;
const ARTIFACT_CACHE_MAX = 128;
const phases = new Set(['preparing', 'planning', 'thinking', 'crafting', 'building', 'evaluating', 'completed', 'failed', 'canceled', 'working']);
const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const integer = (value, max = 9999) => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isInteger(number) ? Math.max(0, Math.min(max, number)) : null;
};
function files(value, limit = 30) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit).flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const name = text(item.name, 180), relativePath = text(item.path || item.relativePath, 260);
    if (!name && !relativePath) return [];
    const updatedAt = Number.isFinite(Date.parse(item.updatedAt)) ? new Date(item.updatedAt).toISOString() : null;
    const artifactId = text(item.artifactId, 100);
    return [{ name: name || relativePath.split(/[\\/]/).pop(), path: relativePath || name, size: integer(item.size, 2 ** 31), updatedAt, ...(artifactId ? { artifactId } : {}) }];
  });
}
function diagnosticCategory(stage, message, stderr, stdout) {
  const output = `${message}\n${stderr}\n${stdout}`;
  if (/timed out|timeout/i.test(message)) return 'timeout';
  if (/stale\s+arg0|error\s*145|directory\s+not\s+empty|(?:temporary|temp)\s+director(?:y|ies).*(?:clean|remov)|clean(?:ing|up).*(?:temporary|temp)/i.test(output)) return 'workspace-cleanup';
  if (/no diagnostic output/i.test(message) && !stderr && !stdout) return 'missing-output';
  if (/^unreal-project-validation-/i.test(stage)) return 'unreal-validation';
  if (/^production-orchestrator-/i.test(stage)) return 'orchestration';
  if (/^packaged-game-playtest-/i.test(stage)) return 'packaged-playtest';
  return 'worker-step';
}

function parseDiagnosticText(value) {
  let message = text(value, 6000);
  if (!message) return {};
  const categoryMatch = message.match(/^\[([a-z][a-z0-9-]{1,79})\]\s*/i);
  const category = categoryMatch?.[1]?.toLowerCase();
  if (categoryMatch) message = message.slice(categoryMatch[0].length).trim();
  const stageMatch = message.match(/^([a-z][a-z0-9-]*(?:-\d+)?)[ \t]+failed\s*\(exit\s+(-?\d+)\):\s*/i);
  const stage = stageMatch?.[1];
  const exitCode = stageMatch ? Number(stageMatch[2]) : null;
  if (stageMatch) message = message.slice(stageMatch[0].length).trim();
  const stderrMatch = message.match(/(?:^|\n)stderr:\s*\n([\s\S]*?)(?=\nstdout:\s*\n|$)/i);
  const stdoutMatch = message.match(/(?:^|\n)stdout:\s*\n([\s\S]*)$/i);
  return { message: message || text(value, 6000), category, stage, exitCode,
    stderr: stderrMatch?.[1]?.trim(), stdout: stdoutMatch?.[1]?.trim() };
}

function diagnostic(value, context = {}) {
  if (!value) return null;
  const parsed = typeof value === 'string' ? parseDiagnosticText(value) : {};
  const source = { ...context, ...parsed, ...(typeof value === 'string' ? { message: parsed.message } : value) };
  if (!source || typeof source !== 'object') return null;
  const stderr = text(source.stderr, 2400), stdout = text(source.stdout, 2400);
  const message = text(source.message || source.error || stderr || stdout, 2000);
  const stage = text(source.stage || source.step, 180);
  if (!message && !stage && !stderr && !stdout) return null;
  const reportedCategory = text(source.category, 80);
  const inferredCategory = diagnosticCategory(stage, message, stderr, stdout);
  const category = reportedCategory && !['project-or-unknown', 'worker-step'].includes(reportedCategory) ? reportedCategory : inferredCategory;
  const command = text(source.command, 240);
  const logFiles = Array.isArray(source.logFiles) ? source.logFiles.flatMap(file => typeof file === 'string' ? [text(file, 240)] : []).slice(0, 4)
    : stage ? [`${stage}.stdout.jsonl`, `${stage}.stderr.log`] : [];
  const completedSteps = Array.isArray(source.completedSteps) ? source.completedSteps.flatMap(step => typeof step === 'string' ? [text(step, 180)] : []).slice(-12) : [];
  const noOutput = source.noOutput === true || (/no diagnostic output/i.test(message) && !stderr && !stdout);
  return {
    message: message || 'The worker reported a failure without a message.',
    ...(stage ? { stage } : {}),
    ...(category ? { category } : {}),
    ...(command ? { command } : {}),
    ...(integer(source.attempt, 999) !== null ? { attempt: integer(source.attempt, 999) } : {}),
    ...(Number.isInteger(source.exitCode) ? { exitCode: source.exitCode } : {}),
    ...(source.timedOut === true ? { timedOut: true } : {}),
    ...(noOutput ? { noOutput: true } : {}),
    ...(stderr ? { stderr } : {}),
    ...(stdout ? { stdout } : {}),
    ...(logFiles.length ? { logFiles } : {}),
    ...(completedSteps.length ? { completedSteps } : {}),
  };
}
export function normalizeProgress(input, fallbackGoal = '') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const phaseValue = text(input.phase, 40).toLowerCase();
  const phase = phases.has(phaseValue) ? phaseValue : phaseValue.match(/^[a-z][a-z0-9_-]{1,39}$/) ? phaseValue : 'working';
  const tool = text(typeof input.tool === 'object' ? input.tool?.name : input.tool, 100);
  const command = text(typeof input.tool === 'object' ? input.tool?.command : input.command, 180);
  const prompt = text(typeof input.prompt === 'object' ? input.prompt?.text : input.prompt, 16000);
  const failureDiagnostic = diagnostic(input.diagnostic || input.error, { stage: input.step, command });
  const observedAt = Number.isFinite(Date.parse(input.updatedAt)) ? new Date(input.updatedAt).toISOString() : null;
  const steps = input.steps && typeof input.steps === 'object' ? input.steps : input;
  const completed = integer(steps.completed ?? input.stepsCompleted);
  const total = integer(steps.total ?? input.stepsTotal);
  return {
    phase,
    status: text(input.status, 20).toLowerCase() || 'running',
    error: text(input.error, 2000) || failureDiagnostic?.message || null,
    diagnostic: failureDiagnostic,
    goal: text(input.goal || input.taskGoal || fallbackGoal, 4000),
    step: text(input.step || input.stepName, 180),
    tool: tool || null,
    command: command || null,
    steps: { completed, total },
    iteration: integer(input.iteration, 999),
    iterationTotal: integer(input.iterationTotal, 999),
    prompt: prompt || null,
    screenshots: files(input.screenshots, 2),
    projectFiles: files(input.projectFiles, 4),
    logFiles: files(input.logFiles, 4),
    observedAt,
    receivedAt: new Date().toISOString(),
  };
}
function progressSignature(value) {
  if (!value || typeof value !== 'object') return '';
  const { receivedAt, observedAt, ...stable } = value;
  return JSON.stringify(stable);
}
const phaseProgress = { preparing: 5, planning: 15, thinking: 30, crafting: 50, building: 70, evaluating: 90, completed: 100, failed: 95, canceled: 95, expired: 95 };
function progressPercent(value, taskStatus = '') {
  if (!value || typeof value !== 'object') return null;
  const currentStatus = String(taskStatus || value.status || '').toLowerCase(), currentPhase = String(value.phase || '').toLowerCase();
  if (currentStatus === 'completed' || currentPhase === 'completed') return 100;
  const statusProgress = phaseProgress[currentStatus] || 0;
  const completed = integer(value.steps?.completed ?? value.stepsCompleted, 9999);
  const total = integer(value.steps?.total ?? value.stepsTotal, 9999);
  const stepPercent = completed !== null && total > 0 ? Math.round(Math.max(0, Math.min(1, completed / total)) * 100) : null;
  const iteration = integer(value.iteration, 999999), iterationTotal = integer(value.iterationTotal, 999999);
  if (iteration !== null && iterationTotal > 0) {
    const iterationPercent = Math.round(Math.max(0, Math.min(1, (iteration - 1 + (stepPercent ?? 0) / 100) / iterationTotal)) * 100);
    return Math.max(iterationPercent, phaseProgress[currentPhase] || 0, statusProgress, currentStatus === 'running' ? 1 : 0);
  }
  return Math.max(stepPercent ?? 0, phaseProgress[currentPhase] || 0, statusProgress, currentStatus === 'running' ? 1 : 0);
}
function progressForUser(value, taskStatus = '') {
  if (!value || typeof value !== 'object') return value;
  const screenshots = Array.isArray(value.screenshots) ? value.screenshots.slice(0, 2).map(item => {
    if (!item.artifactId) return item;
    const downloadUrl = `/artifacts/${encodeURIComponent(item.artifactId)}`;
    const previewUrl = /\.png$/i.test(item.name || item.path || '') ? `${downloadUrl}?preview=1` : null;
    return { ...item, downloadUrl, ...(previewUrl ? { previewUrl } : {}) };
  }) : [];
  return { ...value, percent: progressPercent(value, taskStatus), screenshots };
}
function runSummary(item, taskStatus) {
  if (item.resultSummary) return item.resultSummary;
  const result = item.result && typeof item.result === 'object' ? item.result : {};
  const report = result.report && typeof result.report === 'object' ? result.report : {};
  if (report.failure || result.reason) return String(report.failure || result.reason).slice(0, 1000);
  if (item.status === 'COMPLETED' || report.passed === true) return 'Completed and passed the required validation.';
  if (item.status === 'CANCELED' || taskStatus === 'CANCELED') return 'Canceled before the iteration completed.';
  if (item.status === 'EXPIRED' || taskStatus === 'EXPIRED') return 'The iteration deadline expired before completion.';
  return `Iteration ended with status ${String(item.status || 'UNKNOWN').toLowerCase()}.`;
}
function iterationFailures(row) {
  const failures = Array.isArray(row.failures) ? row.failures : [];
  const result = [];
  for (const item of failures) {
    if (!item || typeof item !== 'object') continue;
    const value = diagnostic(item.diagnostic || item);
    if (!value || result.some(existing => JSON.stringify(existing) === JSON.stringify(value))) continue;
    result.push(value);
  }
  return result;
}
function iterationSummaries(rows, task, runs, diagnosticArtifacts = {}) {
  const report = task.result?.report && typeof task.result.report === 'object' ? task.result.report : {};
  const reportDiagnostics = Array.isArray(report.failureDiagnostics) ? iterationFailures({ failures: report.failureDiagnostics.map(item => ({ diagnostic: item })) }) : [];
  const reportHasFailure = task.status === 'FAILED' || reportDiagnostics.length > 0 || Boolean(report.failure);
  const reportArtifactId = reportHasFailure ? text(report.failureDiagnosticsArtifactId, 120) || text(diagnosticArtifacts.report, 120) : '';
  const grouped = rows.map(row => ({ progress: row.progress || {}, failures: row.failures || [], steps: Array.isArray(row.steps) ? row.steps : [], updatedAt: row.created_at }))
    .filter(item => integer(item.progress.iteration, 999999) !== null)
    .sort((a, b) => integer(a.progress.iteration, 999999) - integer(b.progress.iteration, 999999));
  if (!grouped.length) return runs.filter(item => terminal.has(item.status) || terminal.has(item.jobStatus)).map(item => ({
    iteration: null,
    status: item.status,
    goal: item.objective || task.objective,
    summary: runSummary(item, task.status),
    updatedAt: item.finishedAt || item.createdAt,
    failureReasons: reportDiagnostics,
    ...(reportArtifactId ? { diagnosticArtifactId: reportArtifactId } : {}),
    diagnosticMissing: false,
  }));
  return grouped.map((item, index) => {
    const progress = item.progress, iteration = integer(progress.iteration, 999999), next = grouped[index + 1];
    const observedSteps = Array.isArray(item.steps) ? item.steps.filter(step => typeof step === 'string' && step && !step.startsWith('production iteration ')) : [];
    const failures = iterationFailures(item).map(failure => failure.completedSteps?.length || !observedSteps.length || !failure.stage ? failure : { ...failure, completedSteps: observedSteps.filter(step => step !== failure.stage).slice(-12) });
    const continued = Boolean(next);
    const terminalStatus = continued ? (failures.length ? 'FAILED' : 'RETRIED') : task.status;
    let summary = failures[0]?.message || progress.error || '';
    if (!summary && continued) summary = `Iteration was retried before a passing result. No failure diagnostic was reported by the worker.`;
    if (!summary && terminalStatus === 'COMPLETED') summary = 'Completed and passed the required validation.';
    if (!summary && terminalStatus === 'EXPIRED') summary = 'The task deadline expired before completion.';
    if (!summary && terminalStatus === 'CANCELED') summary = 'Canceled before the iteration completed.';
    if (!summary && terminalStatus === 'FAILED') summary = 'The iteration failed validation.';
    if (!summary) summary = `In progress: ${progress.step || progress.phase || 'working'}.`;
    const iterationArtifactId = text(diagnosticArtifacts[iteration], 120) || reportArtifactId;
    return { iteration, status: terminalStatus, goal: text(progress.goal || task.objective, 4000), summary: summary.slice(0, 1000), step: text(progress.step, 180), failureReasons: failures,
      ...(iterationArtifactId && (failures.length || terminalStatus === 'FAILED') ? { diagnosticArtifactId: iterationArtifactId } : {}),
      diagnosticMissing: continued && !failures.length, updatedAt: item.updatedAt, percent: progressPercent(progress) };
  });
}
function artifactCursor(value) {
  return Buffer.from(JSON.stringify([new Date(value.created_at).toISOString(), value.artifact_id])).toString('base64url');
}
function parseArtifactCursor(value) {
  if (!value) return null;
  let decoded;
  try { decoded = JSON.parse(Buffer.from(value, 'base64url').toString()); } catch { throw problem(400, 'Invalid artifact cursor.'); }
  if (!Array.isArray(decoded) || decoded.length !== 2 || !Number.isFinite(Date.parse(decoded[0])) || typeof decoded[1] !== 'string' || !decoded[1]) throw problem(400, 'Invalid artifact cursor.');
  return decoded;
}
async function artifactPage(client, taskId, { cursor = null, limit = ARTIFACT_PAGE_SIZE } = {}) {
  const pageSize = Math.max(1, Math.min(100, Number(limit) || ARTIFACT_PAGE_SIZE));
  const cacheKey = `${taskId}:${pageSize}`;
  if (!cursor) {
    const cached = artifactPageCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
  }
  const rows = (await client.query(`SELECT artifact_id,name,content_type,size_bytes,sha256,created_at
    FROM artifacts WHERE task_id=$1 AND verified=true
    AND ($2::timestamptz IS NULL OR (created_at,artifact_id)<($2::timestamptz,$3::text))
    ORDER BY created_at DESC,artifact_id DESC LIMIT $4`, [taskId, cursor?.[0] || null, cursor?.[1] || null, pageSize + 1])).rows;
  const hasMore = rows.length > pageSize, selected = rows.slice(0, pageSize), next = selected.at(-1);
  const summary = (await client.query('SELECT count(*)::int AS count,coalesce(sum(size_bytes),0)::bigint AS bytes FROM artifacts WHERE task_id=$1 AND verified=true', [taskId])).rows[0];
  const value = { artifacts: selected, nextCursor: hasMore ? artifactCursor(next) : null, count: summary.count, bytes: summary.bytes };
  if (!cursor) {
    while (artifactPageCache.size >= ARTIFACT_CACHE_MAX) artifactPageCache.delete(artifactPageCache.keys().next().value);
    artifactPageCache.set(cacheKey, { expiresAt: Date.now() + ARTIFACT_CACHE_TTL, value });
  }
  return value;
}
export function invalidateArtifactCache(taskId) {
  for (const key of artifactPageCache.keys()) if (key.startsWith(`${taskId}:`)) artifactPageCache.delete(key);
}
function artifactForUser(value) {
  const image = ['image/png', 'image/jpeg', 'image/webp'].includes(value.content_type);
  return { ...value, downloadUrl: `/artifacts/${encodeURIComponent(value.artifact_id)}`, ...(image && value.content_type === 'image/png' ? { previewUrl: `/artifacts/${encodeURIComponent(value.artifact_id)}?preview=1` } : {}) };
}
// A short database lock serializes pilot scheduling and state transitions across API processes.
export const change = (db, fn) => transaction(db, async client => {
  await client.query('SELECT pg_advisory_xact_lock(73402103)');
  return fn(client);
});
export async function event(client, taskId, type, payload = {}) {
  await client.query('INSERT INTO task_events(task_id,event_type,payload) VALUES($1,$2,$3)', [taskId, type, payload]);
}
export async function ownedTask(db, taskId, userId) {
  const task = (await db.query('SELECT * FROM tasks WHERE task_id=$1 AND user_id=$2', [taskId, userId])).rows[0];
  if (!task) throw problem(404, 'Task not found.');
  return task;
}
export async function createTask(db, userId, input) {
  if ('ownerId' in input || 'workerId' in input || 'archiveDirectory' in input || 'codexPrompt' in input || 'kind' in input || 'unrealProject' in input || 'blendFile' in input) throw problem(400, 'Task execution is created from the objective; workspace files are managed by the worker.');
  const objective = String(input.objective || '').trim();
  if (!objective || objective.length > 4000) throw problem(400, 'Objective must contain 1-4000 characters.');
  const kind = 'production';
  const payload = { workspacePolicy: 'new-per-task', projectFiles: 'worker-managed' };
  return change(db, async client => {
    const taskId = id('task'), jobId = id('job'), workspaceId = id('workspace'), revisionId = id('revision'), runId = id('run');
    await client.query("INSERT INTO tasks(task_id,user_id,owner_id,kind,objective,payload,status,deadline_at) VALUES($1,$2,$2,$3,$4,$5,'QUEUED',now()+interval '24 hours')", [taskId, userId, kind, objective, payload]);
    await client.query('INSERT INTO workspaces(workspace_id,task_id,relative_root) VALUES($1,$2,$1)', [workspaceId, taskId]);
    const frozen = { kind, objective, payload };
    await client.query('INSERT INTO task_revisions(revision_id,task_id,revision_number,input,input_hash) VALUES($1,$2,1,$3,$4)', [revisionId, taskId, frozen, digest(JSON.stringify(frozen))]);
    await client.query("INSERT INTO task_runs(run_id,task_id,revision_id,status) VALUES($1,$2,$3,'QUEUED')", [runId, taskId, revisionId]);
    await client.query('INSERT INTO jobs(job_id,task_id,run_id,payload,objective) VALUES($1,$2,$3,$4,$5)', [jobId, taskId, runId, payload, objective]);
    await event(client, taskId, 'TASK_CREATED', { taskId, runId, workspaceId });
    return { taskId, workspaceId, runId, jobId, status: 'QUEUED' };
  });
}
export async function taskView(db, taskId, userId) {
  return transaction(db, async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const task = await ownedTask(client, taskId, userId);
    const workspace = (await client.query('SELECT * FROM workspaces WHERE task_id=$1', [taskId])).rows[0];
    const runs = (await client.query(`SELECT r.run_id,r.status,r.revision_id,r.created_at,r.finished_at,rev.input,
        j.job_id,j.status AS job_status,j.objective,j.progress,j.result,j.lease_until,j.attempt,j.updated_at AS job_updated_at,
        w.status AS worker_status,w.capabilities,w.last_seen_at
      FROM task_runs r JOIN task_revisions rev ON rev.revision_id=r.revision_id
      LEFT JOIN jobs j ON j.run_id=r.run_id LEFT JOIN workers w ON w.worker_id=j.worker_id
      WHERE r.task_id=$1 ORDER BY r.created_at DESC`, [taskId])).rows;
    const run = runs[0];
    const job = (await client.query(`SELECT j.progress,j.lease_until,j.attempt,j.objective,j.updated_at AS job_updated_at,w.status AS worker_status,w.capabilities,w.last_seen_at
      FROM jobs j LEFT JOIN workers w ON w.worker_id=j.worker_id WHERE j.task_id=$1 ORDER BY j.created_at DESC LIMIT 1`, [taskId])).rows[0];
    const events = (await client.query('SELECT event_id,event_type,created_at FROM task_events WHERE task_id=$1 ORDER BY event_id DESC LIMIT 50', [taskId])).rows.reverse();
    const iterationRows = (await client.query(`WITH progress AS (
        SELECT event_id,created_at,payload->'progress' AS progress,payload->'progress'->>'iteration' AS iteration
        FROM task_events WHERE task_id=$1 AND event_type='WORKER_PROGRESS'
          AND payload->>'runId'=$2
          AND (payload->'progress'->>'iteration') ~ '^[0-9]+$'
      ), latest AS (
        SELECT DISTINCT ON (iteration) iteration,progress,created_at
        FROM progress ORDER BY iteration,event_id DESC
      ), failures AS (
        SELECT iteration,jsonb_agg(DISTINCT CASE
          WHEN jsonb_typeof(progress->'diagnostic') = 'object' THEN jsonb_build_object('diagnostic',progress->'diagnostic')
          ELSE jsonb_build_object('diagnostic',jsonb_build_object('message',NULLIF(progress->>'error',''), 'stage',NULLIF(progress->>'step',''), 'command',NULLIF(progress->>'command','')))
        END) FILTER (WHERE NULLIF(progress->>'error','') IS NOT NULL OR (progress ? 'diagnostic' AND progress->'diagnostic' <> 'null'::jsonb)) AS failures
        FROM progress GROUP BY iteration
      ), steps AS (
        SELECT iteration,jsonb_agg(DISTINCT NULLIF(progress->>'step','')) FILTER (WHERE NULLIF(progress->>'step','') IS NOT NULL) AS steps
        FROM progress GROUP BY iteration
      )
      SELECT latest.progress,latest.created_at,COALESCE(failures.failures,'[]'::jsonb) AS failures,COALESCE(steps.steps,'[]'::jsonb) AS steps
      FROM latest LEFT JOIN failures USING (iteration) LEFT JOIN steps USING (iteration)
      ORDER BY latest.iteration::int`, [taskId, run?.run_id || ''])).rows;
    const artifactResult = await artifactPage(client, taskId);
    const diagnosticArtifacts = {};
    for (const artifact of (await client.query(`SELECT artifact_id,name FROM artifacts
        WHERE task_id=$1 AND job_id=$2 AND verified=true
          AND (name='production-report.json' OR name ~ '^iteration-monitor-[0-9]+(?:-validator)?\\.json$')
        ORDER BY created_at DESC`, [taskId, run?.job_id || null])).rows) {
      if (artifact.name === 'production-report.json') diagnosticArtifacts.report ||= artifact.artifact_id;
      else {
        const match = artifact.name.match(/^iteration-monitor-(\d+)(?:-validator)?\.json$/);
        if (match) diagnosticArtifacts[Number(match[1])] ||= artifact.artifact_id;
      }
    }
    const progress = job?.progress && Object.keys(job.progress).length ? progressForUser(job.progress, task.status) : null;
    const runsForUser = runs.map(item => ({ runId: item.run_id, status: item.status, jobId: item.job_id, jobStatus: item.job_status, objective: item.objective || task.objective,
      followUpPrompt: item.input?.followUpPrompt || null, createdAt: item.created_at, finishedAt: item.finished_at, resultSummary: runSummary(item, task.status) }));
    return { taskId, ownerId: userId, objective: task.objective, kind: task.kind, status: task.status, workerId: task.worker_id,
      workspaceId: workspace?.workspace_id, runId: run?.run_id, deadlineAt: task.deadline_at, createdAt: task.created_at,
      updatedAt: task.updated_at, result: task.result, currentPrompt: run?.input?.followUpPrompt || null, progress,
      worker: task.worker_id ? { workerId: task.worker_id, status: job?.worker_status || 'OFFLINE', capabilities: job?.capabilities || {}, lastSeenAt: job?.last_seen_at || null,
        leaseUntil: job?.lease_until || null, attempt: job?.attempt || 0, updatedAt: job?.job_updated_at || null } : null,
      runs: runsForUser, iterationSummaries: iterationSummaries(iterationRows, task, runsForUser, diagnosticArtifacts),
      events, eventCursor: events.at(-1)?.event_id || '0',
      allowedActions: terminal.has(task.status) ? ['rerun'] : task.status === 'CANCELING' ? [] : ['cancel'],
      artifacts: artifactResult.artifacts.map(artifactForUser), artifactCount: artifactResult.count, artifactBytes: artifactResult.bytes,
      artifactsNextCursor: artifactResult.nextCursor };
  });
}
export async function artifactView(db, taskId, userId, options = {}) {
  return transaction(db, async client => {
    await ownedTask(client, taskId, userId);
    const result = await artifactPage(client, taskId, { cursor: parseArtifactCursor(options.cursor), limit: options.limit });
    return { artifacts: result.artifacts.map(artifactForUser), count: result.count, bytes: result.bytes, nextCursor: result.nextCursor };
  });
}
export async function cancelTask(db, taskId, userId) {
  return change(db, async client => {
    const task = await ownedTask(client, taskId, userId);
    if (terminal.has(task.status) || task.status === 'CANCELING') return { taskId, status: task.status };
    const state = task.status === 'QUEUED' ? 'CANCELED' : 'CANCELING';
    await client.query("UPDATE tasks SET status=$2,cancel_reason='CANCELED',updated_at=now() WHERE task_id=$1", [taskId, state]);
    await client.query("UPDATE jobs SET status=$2,updated_at=now() WHERE task_id=$1 AND status IN ('QUEUED','RUNNING','CANCELING','RECOVERING')", [taskId, state]);
    await client.query('UPDATE task_runs SET status=$2,finished_at=CASE WHEN $2=\'CANCELED\' THEN now() ELSE NULL END WHERE task_id=$1 AND finished_at IS NULL', [taskId, state]);
    await event(client, taskId, state === 'CANCELED' ? 'TASK_CANCELED' : 'CANCEL_REQUESTED');
    return { taskId, status: state };
  });
}
export async function rerunTask(db, taskId, userId, input) {
  const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt || prompt.length > 4000) throw problem(400, 'Follow-up prompt must contain 1-4000 characters.');
  return change(db, async client => {
    const task = await ownedTask(client, taskId, userId);
    if (!terminal.has(task.status)) throw problem(409, 'Only a terminal task can be continued.');
    if ((await client.query("SELECT 1 FROM worker_allocations wa JOIN jobs j ON j.job_id=wa.job_id WHERE j.task_id=$1 AND wa.released_at IS NULL", [taskId])).rowCount) {
      throw problem(409, 'The previous worker execution is still shutting down.');
    }
    const priorRun = (await client.query('SELECT run_id FROM task_runs WHERE task_id=$1 ORDER BY created_at DESC LIMIT 1', [taskId])).rows[0];
    const revisionNumber = Number((await client.query('SELECT COALESCE(MAX(revision_number),0)+1 AS next FROM task_revisions WHERE task_id=$1', [taskId])).rows[0].next);
    const runId = id('run'), jobId = id('job'), revisionId = id('revision');
    const payload = { ...(task.payload || {}), followUpPrompt: prompt, parentRunId: priorRun?.run_id || null, workspacePolicy: 'continue-existing' };
    const revisionInput = { kind: task.kind, objective: task.objective, followUpPrompt: prompt, payload };
    const previous = (await client.query('SELECT input FROM task_revisions WHERE task_id=$1 ORDER BY revision_number', [taskId])).rows
      .map(row => row.input.followUpPrompt).filter(Boolean);
    const objective = [task.objective, ...previous.map((value, index) => `Previous modification ${index + 1}:\n${value}`),
      `Follow-up modification request:\n${prompt}`,
      'Continue from the existing workspace and preserve previous changes. The latest modification takes precedence when requests conflict. Revalidate the deliverables for this modification.'
    ].join('\n\n');
    await client.query('INSERT INTO task_revisions(revision_id,task_id,revision_number,input,input_hash) VALUES($1,$2,$3,$4,$5)', [revisionId, taskId, revisionNumber, revisionInput, digest(JSON.stringify(revisionInput))]);
    await client.query("INSERT INTO task_runs(run_id,task_id,revision_id,status) VALUES($1,$2,$3,'QUEUED')", [runId, taskId, revisionId]);
    await client.query('INSERT INTO jobs(job_id,task_id,run_id,payload,objective) VALUES($1,$2,$3,$4,$5)', [jobId, taskId, runId, payload, objective]);
    await client.query("UPDATE tasks SET status='QUEUED',cancel_reason=NULL,result=NULL,deadline_at=now()+interval '24 hours',updated_at=now() WHERE task_id=$1", [taskId]);
    await event(client, taskId, 'TASK_FOLLOWUP_REQUESTED', { taskId, runId, jobId, prompt });
    return { taskId, runId, jobId, workspaceId: (await client.query('SELECT workspace_id FROM workspaces WHERE task_id=$1', [taskId])).rows[0]?.workspace_id, status: 'QUEUED' };
  });
}
export async function registerWorker(db, worker, input) {
  if (input.protocol !== 2 || !/^[a-zA-Z0-9-]{1,80}$/.test(input.bootId || '')) throw problem(400, 'Worker protocol 2 and bootId required.');
  return change(db, async client => {
    const active = (await client.query('SELECT boot_id FROM worker_allocations WHERE worker_id=$1 AND released_at IS NULL', [worker.worker_id])).rows[0];
    if (active && active.boot_id !== input.bootId) throw problem(409, 'Previous execution requires shutdown verification before a new worker boot.');
    await client.query("UPDATE workers SET boot_id=$2,status='ONLINE',capabilities=$3,last_seen_at=now(),updated_at=now() WHERE worker_id=$1", [worker.worker_id, input.bootId, input.capabilities || {}]);
    return { registered: true, workerId: worker.worker_id, protocol: 2 };
  });
}
export async function pollWorker(db, worker, input, leaseMs) {
  return change(db, async client => {
    const current = (await client.query('SELECT * FROM workers WHERE worker_id=$1', [worker.worker_id])).rows[0];
    if (current.boot_id !== input.bootId || current.status !== 'ONLINE') throw problem(409, 'Register this worker boot first.');
    if ((await client.query('SELECT 1 FROM worker_allocations WHERE worker_id=$1 AND released_at IS NULL', [worker.worker_id])).rowCount) return { job: null };
    const job = (await client.query(`SELECT j.*,t.kind,t.objective AS base_objective,t.deadline_at,w.workspace_id FROM jobs j
      JOIN tasks t ON t.task_id=j.task_id JOIN workspaces w ON w.task_id=t.task_id
      JOIN user_worker_bindings b ON b.user_id=t.user_id JOIN users u ON u.user_id=t.user_id
      WHERE b.worker_id=$1 AND u.status='ACTIVE' AND j.status='QUEUED' AND t.status='QUEUED'
      AND t.deadline_at>now() AND (w.worker_id IS NULL OR w.worker_id=$1) ORDER BY j.created_at,j.job_id LIMIT 1`, [worker.worker_id])).rows[0];
    if (!job) return { job: null };
    const leaseToken = id('lease'), allocationId = id('allocation');
    const leaseUntil = new Date(Date.now() + leaseMs);
    const workspace = (await client.query('UPDATE workspaces SET worker_id=$2,write_epoch=write_epoch+1 WHERE workspace_id=$1 RETURNING write_epoch', [job.workspace_id, worker.worker_id])).rows[0];
    await client.query("UPDATE jobs SET status='RUNNING',worker_id=$2,worker_boot_id=$3,lease_token=$4,lease_until=$5,attempt=attempt+1,updated_at=now() WHERE job_id=$1", [job.job_id, worker.worker_id, input.bootId, leaseToken, leaseUntil]);
    await client.query("UPDATE tasks SET status='RUNNING',worker_id=$2,updated_at=now() WHERE task_id=$1", [job.task_id, worker.worker_id]);
    await client.query("UPDATE task_runs SET status='RUNNING' WHERE run_id=$1", [job.run_id]);
    await client.query('INSERT INTO worker_allocations(allocation_id,job_id,workspace_id,worker_id,boot_id,write_epoch) VALUES($1,$2,$3,$4,$5,$6)', [allocationId, job.job_id, job.workspace_id, worker.worker_id, input.bootId, workspace.write_epoch]);
    await event(client, job.task_id, 'STEP_STARTED', { workerId: worker.worker_id, jobId: job.job_id, runId: job.run_id });
    return { job: { protocol: 2, jobId: job.job_id, taskId: job.task_id, runId: job.run_id, workspaceId: job.workspace_id,
      allocationId, writeEpoch: workspace.write_epoch, leaseToken, leaseUntil: leaseUntil.toISOString(), deadlineAt: job.deadline_at,
      kind: job.kind, objective: job.objective || job.base_objective, payload: job.payload } };
  });
}
export async function matchingJob(client, worker, input) {
  const job = (await client.query(`SELECT j.*,t.status AS task_status,t.cancel_reason,t.deadline_at,t.kind,t.objective AS base_objective,r.finished_at AS run_finished_at
    FROM jobs j JOIN tasks t USING(task_id) JOIN task_runs r ON r.run_id=j.run_id WHERE j.job_id=$1`, [input.jobId])).rows[0];
  if (!job || job.worker_id !== worker.worker_id || job.worker_boot_id !== input.bootId || job.lease_token !== input.leaseToken || job.task_id !== input.taskId) throw problem(409, 'Stale or invalid execution lease.');
  return job;
}
export async function reconcile(db) {
  return change(db, async client => {
    const tasks = (await client.query(`SELECT t.*,j.job_id,j.lease_until FROM tasks t JOIN jobs j USING(task_id)
      JOIN task_runs r ON r.run_id=j.run_id AND r.finished_at IS NULL
      WHERE j.status IN ('QUEUED','RUNNING') AND t.user_id IS NOT NULL AND ((t.status IN ('QUEUED','RUNNING') AND t.deadline_at<=now()) OR (t.status='RUNNING' AND j.lease_until<=now()))`)).rows;
    for (const task of tasks) {
      const expired = new Date(task.deadline_at) <= new Date();
      const state = task.status === 'QUEUED' ? 'EXPIRED' : expired ? 'CANCELING' : 'RECOVERING';
      await client.query('UPDATE tasks SET status=$2,cancel_reason=$3,updated_at=now() WHERE task_id=$1', [task.task_id, state, expired ? 'EXPIRED' : 'LEASE_LOST']);
      await client.query('UPDATE jobs SET status=$2,updated_at=now() WHERE job_id=$1', [task.job_id, state]);
      await client.query("UPDATE task_runs SET status=$2,finished_at=CASE WHEN $2='EXPIRED' THEN now() ELSE NULL END WHERE task_id=$1 AND finished_at IS NULL", [task.task_id, state]);
      await event(client, task.task_id, 'TASK_CONTROL_CHANGED', { status: state });
    }
  });
}
export async function heartbeat(db, worker, input, leaseMs) {
  await reconcile(db);
  return change(db, async client => {
    const current = (await client.query('SELECT boot_id FROM workers WHERE worker_id=$1', [worker.worker_id])).rows[0];
    if (current.boot_id !== input.bootId) throw problem(409, 'Stale worker boot.');
    await client.query('UPDATE workers SET last_seen_at=now(),updated_at=now() WHERE worker_id=$1', [worker.worker_id]);
    if (!input.jobId) return { ok: true };
    const job = await matchingJob(client, worker, input);
    if (job.run_finished_at) return { ok: true, action: 'STOP', reason: job.status };
    const progress = normalizeProgress(input.progress, job.objective || job.base_objective);
    if (progress) {
      const changed = progressSignature(job.progress) !== progressSignature(progress);
      await client.query('UPDATE jobs SET progress=$2,updated_at=now() WHERE job_id=$1', [job.job_id, progress]);
      await client.query('UPDATE tasks SET updated_at=now() WHERE task_id=$1', [job.task_id]);
      if (changed) await event(client, job.task_id, 'WORKER_PROGRESS', { workerId: worker.worker_id, jobId: job.job_id, runId: job.run_id, progress });
    }
    if (terminal.has(job.task_status)) return { ok: true, action: 'STOP', reason: job.task_status };
    if (job.task_status !== 'RUNNING') return { ok: true, action: 'STOP', reason: job.cancel_reason || 'LEASE_LOST' };
    const until = new Date(Math.min(Date.now() + leaseMs, new Date(job.deadline_at).getTime()));
    await client.query('UPDATE jobs SET lease_until=$2 WHERE job_id=$1', [job.job_id, until]);
    return { ok: true, action: 'CONTINUE', leaseUntil: until.toISOString() };
  });
}

// Read-only status for an authenticated worker monitor. This deliberately does
// not poll or mutate an allocation, so watching a worker cannot claim work.
export async function workerStatus(db, worker) {
  const row = (await db.query(`SELECT w.worker_id,w.status,w.boot_id,w.capabilities,w.last_seen_at,w.updated_at,
      wa.allocation_id,wa.job_id AS allocation_job_id,wa.workspace_id AS allocation_workspace_id,
      wa.boot_id AS allocation_boot_id,wa.write_epoch,wa.created_at AS allocation_created_at,
      j.task_id,j.run_id,j.status AS job_status,j.attempt,j.lease_until,
      t.status AS task_status,t.objective,t.deadline_at,t.cancel_reason,
      (SELECT count(*) FROM jobs queued_jobs JOIN tasks queued_tasks ON queued_tasks.task_id=queued_jobs.task_id
        JOIN workspaces queued_workspaces ON queued_workspaces.task_id=queued_tasks.task_id
        JOIN user_worker_bindings queued_bindings ON queued_bindings.user_id=queued_tasks.user_id
        JOIN users queued_users ON queued_users.user_id=queued_tasks.user_id
        WHERE queued_bindings.worker_id=w.worker_id AND queued_users.status='ACTIVE'
          AND queued_jobs.status='QUEUED' AND queued_tasks.status='QUEUED' AND queued_tasks.deadline_at>now()
          AND (queued_workspaces.worker_id IS NULL OR queued_workspaces.worker_id=w.worker_id)) AS queued_jobs
    FROM workers w
    LEFT JOIN worker_allocations wa ON wa.worker_id=w.worker_id AND wa.released_at IS NULL
    LEFT JOIN jobs j ON j.job_id=wa.job_id
    LEFT JOIN tasks t ON t.task_id=j.task_id
    WHERE w.worker_id=$1`, [worker.worker_id])).rows[0];
  if (!row) throw problem(404, 'Worker not found.');
  return {
    workerId: row.worker_id,
    status: row.status,
    bootId: row.boot_id,
    capabilities: row.capabilities,
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at,
    queuedJobs: Number(row.queued_jobs || 0),
    active: row.allocation_id ? {
      allocationId: row.allocation_id,
      jobId: row.allocation_job_id,
      taskId: row.task_id,
      runId: row.run_id,
      workspaceId: row.allocation_workspace_id,
      bootId: row.allocation_boot_id,
      writeEpoch: Number(row.write_epoch),
      allocatedAt: row.allocation_created_at,
      jobStatus: row.job_status,
      taskStatus: row.task_status,
      attempt: row.attempt,
      leaseUntil: row.lease_until,
      deadlineAt: row.deadline_at,
      cancelReason: row.cancel_reason,
      objective: row.objective
    } : null
  };
}
export async function stepResult(db, worker, input) {
  await reconcile(db);
  return change(db, async client => {
    const job = await matchingJob(client, worker, input);
    if (job.run_finished_at) return { accepted: job.status === 'COMPLETED', status: job.status, duplicate: true };
    if (input.stopConfirmed !== true) throw problem(409, 'Process shutdown is unconfirmed; allocation remains reserved.');
    let status;
    if (job.cancel_reason) status = job.cancel_reason === 'EXPIRED' ? 'EXPIRED' : job.cancel_reason === 'CANCELED' ? 'CANCELED' : 'FAILED';
    else if (input.status === 'CANCELED' || input.status === 'FAIL') status = 'FAILED';
    else if (input.status === 'PASS') {
      const ids = [...new Set(Array.isArray(input.artifactIds) ? input.artifactIds : [])];
      const artifacts = (await client.query('SELECT name FROM artifacts WHERE artifact_id=ANY($1::text[]) AND task_id=$2 AND job_id=$3 AND verified=true', [ids, job.task_id, job.job_id])).rows;
      const required = ['production-report.json'];
      if (!ids.length || artifacts.length !== ids.length || !required.every(name => artifacts.some(a => a.name === name)) || input.report?.passed !== true) throw problem(422, 'Required verified task artifacts and passing report are missing.');
      if (input.report?.production === true) {
        const names = artifacts.map(a => a.name);
        const hasProject = names.some(name => /\.uproject$/i.test(name));
        const hasPreview = names.some(name => /^scene-preview\.(png|jpe?g|webp)$/i.test(name));
        const hasPackage = names.some(name => /\.exe$/i.test(name) && !/^unreal(editor|pak)/i.test(name));
        const hasAcceptance = names.some(name => /^acceptance-report\.json$/i.test(name));
        if (!hasProject || !hasPreview || !hasPackage || !hasAcceptance) throw problem(422, 'Production completion requires a .uproject, scene preview, packaged game and acceptance report.');
      }
      status = 'COMPLETED';
    } else throw problem(400, 'Invalid execution result.');
    const progress = normalizeProgress(input.progress, job.objective || job.base_objective) || job.progress || null;
    if (progress) progress.status = status === 'COMPLETED' ? 'completed' : status === 'CANCELED' ? 'canceled' : 'failed';
    const recorded = { status: input.status, reason: input.reason || null, artifactIds: input.artifactIds || [], report: input.report || null, stopConfirmed: true };
    await client.query('UPDATE tasks SET status=$2,result=$3,updated_at=now() WHERE task_id=$1', [job.task_id, status, recorded]);
    await client.query('UPDATE jobs SET status=$2,result=$3,progress=COALESCE($4,progress),updated_at=now() WHERE job_id=$1', [job.job_id, status, recorded, progress]);
    await client.query('UPDATE task_runs SET status=$2,finished_at=now() WHERE run_id=$1', [job.run_id, status]);
    await client.query('UPDATE worker_allocations SET released_at=now() WHERE job_id=$1', [job.job_id]);
    await event(client, job.task_id, `TASK_${status}`, { status, reason: input.reason || null });
    return { accepted: status === 'COMPLETED', status };
  });
}
