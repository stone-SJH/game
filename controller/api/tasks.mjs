import { digest, id, problem, transaction } from './database.mjs';

export const terminal = new Set(['COMPLETED', 'FAILED', 'CANCELED', 'EXPIRED']);
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
    await client.query('INSERT INTO jobs(job_id,task_id,run_id,payload) VALUES($1,$2,$3,$4)', [jobId, taskId, runId, payload]);
    await event(client, taskId, 'TASK_CREATED', { taskId, runId, workspaceId });
    return { taskId, workspaceId, runId, jobId, status: 'QUEUED' };
  });
}
export async function taskView(db, taskId, userId) {
  return transaction(db, async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const task = await ownedTask(client, taskId, userId);
    const workspace = (await client.query('SELECT * FROM workspaces WHERE task_id=$1', [taskId])).rows[0];
    const run = (await client.query('SELECT * FROM task_runs WHERE task_id=$1 ORDER BY created_at DESC LIMIT 1', [taskId])).rows[0];
    const events = (await client.query('SELECT event_id,event_type,payload,created_at FROM task_events WHERE task_id=$1 ORDER BY event_id DESC LIMIT 100', [taskId])).rows.reverse();
    const artifacts = (await client.query('SELECT artifact_id,name,content_type,size_bytes,sha256,created_at FROM artifacts WHERE task_id=$1 AND verified=true ORDER BY created_at', [taskId])).rows;
    return { taskId, ownerId: userId, objective: task.objective, kind: task.kind, status: task.status, workerId: task.worker_id,
      workspaceId: workspace?.workspace_id, runId: run?.run_id, deadlineAt: task.deadline_at, createdAt: task.created_at,
      updatedAt: task.updated_at, result: task.result, events, eventCursor: events.at(-1)?.event_id || '0',
      allowedActions: terminal.has(task.status) || task.status === 'CANCELING' ? [] : ['cancel'],
      artifacts: artifacts.map(a => ({ ...a, downloadUrl: `/artifacts/${a.artifact_id}` })) };
  });
}
export async function cancelTask(db, taskId, userId) {
  return change(db, async client => {
    const task = await ownedTask(client, taskId, userId);
    if (terminal.has(task.status) || task.status === 'CANCELING') return { taskId, status: task.status };
    const state = task.status === 'QUEUED' ? 'CANCELED' : 'CANCELING';
    await client.query("UPDATE tasks SET status=$2,cancel_reason='CANCELED',updated_at=now() WHERE task_id=$1", [taskId, state]);
    await client.query('UPDATE jobs SET status=$2,updated_at=now() WHERE task_id=$1', [taskId, state]);
    await client.query('UPDATE task_runs SET status=$2,finished_at=CASE WHEN $2=\'CANCELED\' THEN now() ELSE NULL END WHERE task_id=$1 AND finished_at IS NULL', [taskId, state]);
    await event(client, taskId, state === 'CANCELED' ? 'TASK_CANCELED' : 'CANCEL_REQUESTED');
    return { taskId, status: state };
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
    const job = (await client.query(`SELECT j.*,t.kind,t.objective,t.deadline_at,w.workspace_id FROM jobs j
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
      kind: job.kind, objective: job.objective, payload: job.payload } };
  });
}
export async function matchingJob(client, worker, input) {
  const job = (await client.query(`SELECT j.*,t.status AS task_status,t.cancel_reason,t.deadline_at,t.kind
    FROM jobs j JOIN tasks t USING(task_id) WHERE j.job_id=$1`, [input.jobId])).rows[0];
  if (!job || job.worker_id !== worker.worker_id || job.worker_boot_id !== input.bootId || job.lease_token !== input.leaseToken || job.task_id !== input.taskId) throw problem(409, 'Stale or invalid execution lease.');
  return job;
}
export async function reconcile(db) {
  return change(db, async client => {
    const tasks = (await client.query(`SELECT t.*,j.job_id,j.lease_until FROM tasks t JOIN jobs j USING(task_id)
      WHERE t.user_id IS NOT NULL AND ((t.status IN ('QUEUED','RUNNING') AND t.deadline_at<=now()) OR (t.status='RUNNING' AND j.lease_until<=now()))`)).rows;
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
    if (terminal.has(job.task_status)) return { accepted: job.task_status === 'COMPLETED', status: job.task_status, duplicate: true };
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
    const recorded = { status: input.status, reason: input.reason || null, artifactIds: input.artifactIds || [], report: input.report || null, stopConfirmed: true };
    await client.query('UPDATE tasks SET status=$2,result=$3,updated_at=now() WHERE task_id=$1', [job.task_id, status, recorded]);
    await client.query('UPDATE jobs SET status=$2,result=$3,updated_at=now() WHERE job_id=$1', [job.job_id, status, recorded]);
    await client.query('UPDATE task_runs SET status=$2,finished_at=now() WHERE run_id=$1', [job.run_id, status]);
    await client.query('UPDATE worker_allocations SET released_at=now() WHERE job_id=$1', [job.job_id]);
    await event(client, job.task_id, `TASK_${status}`, { status, reason: input.reason || null });
    return { accepted: status === 'COMPLETED', status };
  });
}
