import { digest, id, problem, transaction } from './database.mjs';

export const terminal = new Set(['COMPLETED', 'FAILED', 'CANCELED', 'EXPIRED']);
const phases = new Set(['preparing', 'planning', 'thinking', 'crafting', 'building', 'evaluating', 'completed', 'failed', 'canceled', 'working']);
const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const integer = (value, max = 9999) => Number.isInteger(value) ? Math.max(0, Math.min(max, value)) : null;
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
export function normalizeProgress(input, fallbackGoal = '') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const phaseValue = text(input.phase, 40).toLowerCase();
  const phase = phases.has(phaseValue) ? phaseValue : phaseValue.match(/^[a-z][a-z0-9_-]{1,39}$/) ? phaseValue : 'working';
  const tool = text(typeof input.tool === 'object' ? input.tool?.name : input.tool, 100);
  const command = text(typeof input.tool === 'object' ? input.tool?.command : input.command, 180);
  const prompt = text(typeof input.prompt === 'object' ? input.prompt?.text : input.prompt, 16000);
  const observedAt = Number.isFinite(Date.parse(input.updatedAt)) ? new Date(input.updatedAt).toISOString() : null;
  const steps = input.steps && typeof input.steps === 'object' ? input.steps : input;
  const completed = integer(steps.completed ?? input.stepsCompleted);
  const total = integer(steps.total ?? input.stepsTotal);
  return {
    phase,
    status: text(input.status, 20).toLowerCase() || 'running',
    error: text(input.error, 2000) || null,
    goal: text(input.goal || input.taskGoal || fallbackGoal, 4000),
    step: text(input.step || input.stepName, 180),
    tool: tool || null,
    command: command || null,
    steps: { completed, total },
    iteration: integer(input.iteration, 999),
    iterationTotal: integer(input.iterationTotal, 999),
    prompt: prompt || null,
    screenshots: files(input.screenshots, 20),
    projectFiles: files(input.projectFiles, 30),
    logFiles: files(input.logFiles, 30),
    observedAt,
    receivedAt: new Date().toISOString(),
  };
}
function progressSignature(value) {
  if (!value || typeof value !== 'object') return '';
  const { receivedAt, observedAt, ...stable } = value;
  return JSON.stringify(stable);
}
function progressForUser(value) {
  if (!value || typeof value !== 'object') return value;
  const screenshots = Array.isArray(value.screenshots) ? value.screenshots.map(item => item.artifactId ? { ...item, downloadUrl: `/artifacts/${encodeURIComponent(item.artifactId)}` } : item) : [];
  return { ...value, screenshots };
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
        j.job_id,j.status AS job_status,j.objective,j.progress,j.lease_until,j.attempt,j.updated_at AS job_updated_at,
        w.status AS worker_status,w.capabilities,w.last_seen_at
      FROM task_runs r JOIN task_revisions rev ON rev.revision_id=r.revision_id
      LEFT JOIN jobs j ON j.run_id=r.run_id LEFT JOIN workers w ON w.worker_id=j.worker_id
      WHERE r.task_id=$1 ORDER BY r.created_at DESC`, [taskId])).rows;
    const run = runs[0];
    const job = (await client.query(`SELECT j.progress,j.lease_until,j.attempt,j.objective,j.updated_at AS job_updated_at,w.status AS worker_status,w.capabilities,w.last_seen_at
      FROM jobs j LEFT JOIN workers w ON w.worker_id=j.worker_id WHERE j.task_id=$1 ORDER BY j.created_at DESC LIMIT 1`, [taskId])).rows[0];
    const events = (await client.query('SELECT event_id,event_type,payload,created_at FROM task_events WHERE task_id=$1 ORDER BY event_id DESC LIMIT 100', [taskId])).rows.reverse();
    const artifacts = (await client.query('SELECT artifact_id,name,content_type,size_bytes,sha256,created_at FROM artifacts WHERE task_id=$1 AND verified=true ORDER BY created_at', [taskId])).rows;
    const progress = job?.progress && Object.keys(job.progress).length ? progressForUser(job.progress) : null;
    return { taskId, ownerId: userId, objective: task.objective, kind: task.kind, status: task.status, workerId: task.worker_id,
      workspaceId: workspace?.workspace_id, runId: run?.run_id, deadlineAt: task.deadline_at, createdAt: task.created_at,
      updatedAt: task.updated_at, result: task.result, currentPrompt: run?.input?.followUpPrompt || null, progress,
      worker: task.worker_id ? { workerId: task.worker_id, status: job?.worker_status || 'OFFLINE', capabilities: job?.capabilities || {}, lastSeenAt: job?.last_seen_at || null,
        leaseUntil: job?.lease_until || null, attempt: job?.attempt || 0, updatedAt: job?.job_updated_at || null } : null,
      runs: runs.map(item => ({ runId: item.run_id, status: item.status, jobId: item.job_id, jobStatus: item.job_status, objective: item.objective || task.objective,
        followUpPrompt: item.input?.followUpPrompt || null, createdAt: item.created_at, finishedAt: item.finished_at })),
      events, eventCursor: events.at(-1)?.event_id || '0',
      allowedActions: terminal.has(task.status) ? ['rerun'] : task.status === 'CANCELING' ? [] : ['cancel'],
      artifacts: artifacts.map(a => ({ ...a, downloadUrl: `/artifacts/${a.artifact_id}` })) };
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
      if (changed) await event(client, job.task_id, 'WORKER_PROGRESS', { workerId: worker.worker_id, progress });
    }
    if (terminal.has(job.task_status)) return { ok: true, action: 'STOP', reason: job.task_status };
    if (job.task_status !== 'RUNNING') return { ok: true, action: 'STOP', reason: job.cancel_reason || 'LEASE_LOST' };
    const until = new Date(Math.min(Date.now() + leaseMs, new Date(job.deadline_at).getTime()));
    await client.query('UPDATE jobs SET lease_until=$2 WHERE job_id=$1', [job.job_id, until]);
    return { ok: true, action: 'CONTINUE', leaseUntil: until.toISOString() };
  });
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
