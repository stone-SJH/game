import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startDatabase, availablePort } from './database-fixture.mjs';
import { createServer } from '../api/server.mjs';
import { createInvite } from '../api/accounts.mjs';
import { digest, migrate } from '../api/database.mjs';
import { runAgent } from '../../worker/agent/agent.mjs';
import { runCommand, maintainLease } from '../../worker/agent/process-runner.mjs';

let fixture, db, server, origin, alice, bob;
const workerToken = 'test-worker-secret', workerId = 'worker-a';
const agentHeaders = { 'x-worker-id': workerId, 'x-worker-token': workerToken };
async function request(route, { account, data, headers = {}, method } = {}) {
  const response = await fetch(origin + route, { method: method || (data ? 'POST' : 'GET'), headers: {
    origin, 'content-type': 'application/json', ...(account ? { cookie: account.cookie, 'x-csrf-token': account.csrfToken } : {}), ...headers
  }, body: data ? JSON.stringify(data) : undefined });
  const text = await response.text();
  let value; try { value = JSON.parse(text); } catch { value = text; }
  return { status: response.status, value, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function register(username, code) {
  const result = await request('/v1/auth/register', { data: { username, password: 'testing-password-123', code: code || await createInvite(db) } });
  return { ...result.value, cookie: result.cookie, status: result.status };
}
async function create(account = alice) {
  const result = await request('/v1/tasks', { account, data: { objective: 'Verify internal task lifecycle' } });
  assert.equal(result.status, 201, JSON.stringify(result.value)); return result.value;
}
async function claim() {
  const bootId = `boot-${Date.now()}`;
  assert.equal((await request('/v1/worker/register', { headers: agentHeaders, data: { bootId, protocol: 2 } })).status, 200);
  const result = await request('/v1/worker/poll', { headers: agentHeaders, data: { bootId } });
  return { ...result.value.job, bootId };
}
const identity = job => ({ taskId: job.taskId, jobId: job.jobId, bootId: job.bootId, leaseToken: job.leaseToken });
before(async () => {
  fixture = await startDatabase(); db = fixture.db;
  origin = `http://127.0.0.1:${await availablePort()}`;
  server = createServer({ db, origin, artifactRoot: path.join(fixture.root, 'artifacts'), secureCookies: false, maxUsers: 3, leaseMs: 1500 });
  await new Promise(resolve => server.listen(Number(new URL(origin).port), '127.0.0.1', resolve));
  alice = await register('alice'); bob = await register('bob');
  assert.equal(alice.status, 200); assert.equal(bob.status, 200);
  await db.query('INSERT INTO workers(worker_id,token_hash) VALUES($1,$2)', [workerId, digest(workerToken)]);
  await db.query('INSERT INTO user_worker_bindings(user_id,worker_id) VALUES($1,$2)', [alice.user.userId, workerId]);
});
after(async () => { if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await fixture?.close(); });

test('migration is repeatable; invitation redemption and account capacity are atomic', async () => {
  await migrate(db);
  const code = await createInvite(db);
  const results = await Promise.all([register('third-user', code), register('fourth-user', code)]);
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.equal((await register('fifth-user')).status, 409);
  assert.equal(Number((await db.query('SELECT count(*) FROM users')).rows[0].count), 3);
});
test('sessions restore task lists; ownership, CSRF and legacy-token boundaries hold', async () => {
  const task = await create();
  assert.equal((await request(`/v1/tasks/${task.taskId}`, { account: bob })).status, 404);
  assert.equal((await request('/v1/tasks', { headers: { 'x-internal-token': 'old-token' } })).status, 401);
  assert.equal((await request(`/v1/tasks/${task.taskId}/cancel`, { account: alice, headers: { 'x-csrf-token': 'bad' }, data: {} })).status, 403);
  const login = await request('/v1/auth/login', { data: { username: 'alice', password: 'testing-password-123' } });
  const restored = { ...login.value, cookie: login.cookie };
  assert.equal((await request('/v1/auth/me', { account: restored })).value.user.userId, alice.user.userId);
  assert.equal((await request('/v1/tasks', { account: restored })).value.tasks.length, 1);
  assert.equal((await request('/v1/tasks', { account: bob })).value.tasks.length, 0);
  assert.equal((await request(`/v1/tasks/${task.taskId}/cancel`, { account: alice, data: {} })).value.status, 'CANCELED');
  await request('/v1/auth/logout', { account: restored, data: {} });
  assert.equal((await request('/v1/auth/me', { account: restored })).status, 401);
});
test('new tasks reject staged project paths and allocate a clean workspace', async () => {
  const rejected = await request('/v1/tasks', { account: alice, data: { objective: 'Should reject hidden file inputs', unrealProject: 'Old/Project.uproject', blendFile: 'Old/Scene.blend' } });
  assert.equal(rejected.status, 400);
  const first = await create(), second = await create();
  assert.notEqual(first.workspaceId, second.workspaceId);
  assert.equal((await request(`/v1/tasks/${first.taskId}`, { account: alice })).value.kind, 'production');
  await request(`/v1/tasks/${first.taskId}/cancel`, { account: alice, data: {} });
  await request(`/v1/tasks/${second.taskId}/cancel`, { account: alice, data: {} });
});
test('worker binding and allocation prevent duplicate dispatch; cancellation fences late success', async () => {
  const task = await create(), job = await claim();
  assert.equal(job.taskId, task.taskId);
  assert.equal((await request('/v1/worker/poll', { headers: agentHeaders, data: { bootId: job.bootId } })).value.job, null);
  const cancel = await request(`/v1/tasks/${task.taskId}/cancel`, { account: alice, data: {} });
  assert.equal(cancel.status, 202); assert.equal(cancel.value.status, 'CANCELING');
  const control = await request('/v1/worker/heartbeat', { headers: agentHeaders, data: identity(job) });
  assert.equal(control.value.action, 'STOP');
  assert.equal((await request('/v1/worker/step-result', { headers: agentHeaders, data: { ...identity(job), status: 'PASS', stopConfirmed: false } })).status, 409);
  const finish = { ...identity(job), status: 'PASS', stopConfirmed: true };
  assert.equal((await request('/v1/worker/step-result', { headers: agentHeaders, data: finish })).value.status, 'CANCELED');
  assert.equal((await request('/v1/worker/step-result', { headers: agentHeaders, data: finish })).value.status, 'CANCELED');
  assert.equal((await request('/v1/worker/heartbeat', { headers: agentHeaders, data: { ...identity(job), bootId: 'old-boot' } })).status, 409);
});
test('worker telemetry is persisted and exposed with the task stream', async () => {
  const task = await create(), job = await claim();
  const progress = { phase: 'crafting', status: 'running', goal: 'Build the playable scene', step: 'asset-authoring', tool: 'Blender', command: 'blender.exe',
    steps: { completed: 2, total: 5 }, iteration: 2, iterationTotal: 4, prompt: 'Create the scene and verify the lighting.',
    screenshots: [{ name: 'latest.png', path: 'captures/latest.png', size: 2048, updatedAt: new Date().toISOString() }],
    projectFiles: [{ name: 'Main.umap', path: 'Content/Main.umap', size: 4096, updatedAt: new Date().toISOString() }],
    logFiles: [{ name: 'build.log', path: 'run/build.log', size: 128, updatedAt: new Date().toISOString() }] };
  assert.equal((await request('/v1/worker/heartbeat', { headers: agentHeaders, data: { ...identity(job), progress } })).status, 200);
  const view = (await request(`/v1/tasks/${task.taskId}`, { account: alice })).value;
  assert.equal(view.progress.phase, 'crafting');
  assert.deepEqual(view.progress.steps, { completed: 2, total: 5 });
  assert.equal(view.progress.tool, 'Blender');
  assert.equal(view.progress.goal, progress.goal);
  assert.equal(view.progress.screenshots[0].name, 'latest.png');
  assert.equal(view.worker.workerId, workerId);
  assert.equal(view.worker.status, 'ONLINE');
  assert.equal(view.events.at(-1).event_type, 'WORKER_PROGRESS');
  await request('/v1/worker/step-result', { headers: agentHeaders, data: { ...identity(job), status: 'FAIL', stopConfirmed: true, progress } });
});
test('verified artifacts are owner-scoped and completed work is immutable', async () => {
  const task = await create(), job = await claim(), ids = [];
  for (const [name, bytes, type] of [['production-report.json', Buffer.from('{"passed":true}'), 'application/json']]) {
    const artifactId = `artifact-test-${name.split('.')[0]}`; ids.push(artifactId);
    const response = await fetch(`${origin}/v1/worker/artifacts/${task.taskId}/${artifactId}`, { method:'POST', headers: { ...agentHeaders, 'x-job-id':job.jobId, 'x-boot-id':job.bootId, 'x-lease-token':job.leaseToken, 'x-artifact-name':name, 'x-artifact-sha256':digest(bytes), 'content-type':type }, body:bytes });
    assert.equal(response.status,201,await response.text());
    assert.equal((await request(`/artifacts/${artifactId}`,{account:bob})).status,404);
    assert.equal((await request(`/artifacts/${artifactId}`)).status,401);
    assert.equal((await request(`/artifacts/${artifactId}`,{account:alice})).status,200);
  }
  const finish = { ...identity(job), status:'PASS', stopConfirmed:true, artifactIds:ids, report:{passed:true} };
  assert.equal((await request('/v1/worker/step-result',{headers:agentHeaders,data:finish})).value.status,'COMPLETED');
  assert.equal((await request(`/v1/tasks/${task.taskId}/cancel`,{account:alice,data:{}})).value.status,'COMPLETED');
  assert.equal('leaseToken' in (await request(`/v1/tasks/${task.taskId}`,{account:alice})).value.result,false);
});
test('terminal tasks can queue a follow-up run on the same workspace', async () => {
  const task = await create(), first = await claim();
  await request('/v1/worker/step-result', { headers: agentHeaders, data: { ...identity(first), status: 'FAIL', stopConfirmed: true } });
  await db.query("UPDATE tasks SET deadline_at=now()-interval '1 second' WHERE task_id=$1", [task.taskId]);
  const queued = await request(`/v1/tasks/${task.taskId}/rerun`, { account: alice, data: { prompt: 'Add a second playable route and keep the existing work.' } });
  assert.equal(queued.status, 202);
  const beforeClaim = (await request(`/v1/tasks/${task.taskId}`, { account: alice })).value;
  assert.equal(beforeClaim.status, 'QUEUED');
  assert.equal(beforeClaim.workspaceId, task.workspaceId);
  assert.equal(beforeClaim.currentPrompt, 'Add a second playable route and keep the existing work.');
  assert.equal(beforeClaim.runs.length, 2);
  assert.ok(Date.parse(beforeClaim.deadlineAt) > Date.now());
  assert.equal((await request(`/v1/tasks/${task.taskId}/rerun`, { account: alice, data: { prompt: 'Duplicate submission' } })).status, 409);
  assert.equal((await request(`/v1/tasks/${task.taskId}/rerun`, { account: bob, data: { prompt: 'Other user' } })).status, 404);
  const duplicate = await request('/v1/worker/step-result', { headers: agentHeaders, data: { ...identity(first), status: 'FAIL', stopConfirmed: true } });
  assert.equal(duplicate.value.duplicate, true);
  assert.equal(duplicate.value.status, 'FAILED');
  const lateHeartbeat = await request('/v1/worker/heartbeat', { headers: agentHeaders, data: { ...identity(first), progress: { phase: 'crafting' } } });
  assert.equal(lateHeartbeat.value.action, 'STOP');
  assert.equal((await request(`/v1/tasks/${task.taskId}`, { account: alice })).value.progress, null);
  const second = await claim();
  assert.equal(second.taskId, task.taskId);
  assert.equal(second.workspaceId, task.workspaceId);
  assert.match(second.objective, /Follow-up modification request/);
  const lateArtifact = Buffer.from('late artifact');
  const lateUpload = await fetch(`${origin}/v1/worker/artifacts/${task.taskId}/late-artifact`, { method: 'POST', headers: {
    ...agentHeaders, 'x-job-id': first.jobId, 'x-boot-id': first.bootId, 'x-lease-token': first.leaseToken,
    'x-artifact-name': 'late.txt', 'x-artifact-sha256': digest(lateArtifact), 'content-type': 'text/plain'
  }, body: lateArtifact });
  assert.equal(lateUpload.status, 409);
  assert.equal((await request('/v1/worker/step-result', { headers: agentHeaders, data: { ...identity(second), status: 'FAIL', stopConfirmed: true } })).value.status, 'FAILED');
  assert.equal((await request(`/v1/tasks/${task.taskId}/rerun`, { account: alice, data: { prompt: 'Change the lighting only.' } })).status, 202);
  const third = await claim();
  assert.match(third.objective, /Add a second playable route/);
  assert.match(third.objective, /Change the lighting only/);
  await request('/v1/worker/step-result', { headers: agentHeaders, data: { ...identity(third), status: 'FAIL', stopConfirmed: true } });
});
test('long Windows process keeps renewing its lease; cancellation kills its descendant', async () => {
  const task = await create(), root = path.join(fixture.root, 'worker');
  const marker = path.join(fixture.root, 'descendant.pid');
  let childPid;
  const running = runAgent({ control:origin,workerId,token:workerToken,root,once:true,intervalMs:100,
    execute:async (job,ctx)=>{
      ctx.reportProgress({ phase:'building', status:'running', goal:job.objective, step:'long-running-build', tool:'dotnet', steps:{completed:1,total:3} });
      const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(${JSON.stringify(marker)},String(c.pid));setInterval(()=>{},1000);`;
      const result = await runCommand(process.execPath,['-e',script],{cwd:fixture.root,timeoutMs:15000,signal:ctx.signal});
      return {status:'CANCELED',stopConfirmed:result.stopConfirmed,artifactIds:[]};
    } });
  for(let i=0;i<100;i++){ const value=await fs.readFile(marker,'utf8').catch(()=>null);if(value){childPid=Number(value);break;}await delay(50); }
  assert.ok(childPid,'Child process started');
  await delay(2000);
  const liveView = (await request(`/v1/tasks/${task.taskId}`,{account:alice})).value;
  assert.equal(liveView.status,'RUNNING');
  assert.equal(liveView.progress.phase, 'building');
  assert.equal(liveView.progress.tool, 'dotnet');
  const lease=(await db.query('SELECT lease_until FROM jobs WHERE task_id=$1',[task.taskId])).rows[0];
  assert.ok(new Date(lease.lease_until)>new Date());
  await request(`/v1/tasks/${task.taskId}/cancel`,{account:alice,data:{}});
  await running;
  assert.throws(()=>process.kill(childPid,0));
  assert.equal((await request(`/v1/tasks/${task.taskId}`,{account:alice})).value.status,'CANCELED');
});
test('lost leases retain capacity until shutdown is acknowledged', async () => {
  const task=await create(),job=await claim();
  await db.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE job_id=$1",[job.jobId]);
  const heartbeat=await request('/v1/worker/heartbeat',{headers:agentHeaders,data:identity(job)});
  assert.equal(heartbeat.value.action,'STOP');
  assert.equal((await request(`/v1/tasks/${task.taskId}`,{account:alice})).value.status,'RECOVERING');
  assert.equal(Number((await db.query('SELECT count(*) FROM worker_allocations WHERE released_at IS NULL')).rows[0].count),1);
  await request('/v1/worker/step-result',{headers:agentHeaders,data:{...identity(job),status:'FAIL',stopConfirmed:true}});
  assert.equal(Number((await db.query('SELECT count(*) FROM worker_allocations WHERE released_at IS NULL')).rows[0].count),0);
});

test('streamed uploads continue receiving control and lease renewal', async () => {
  const task=await create(), job=await claim(), controller=new AbortController(); let heartbeats=0;
  const stop=maintainLease({job,controller,intervalMs:150,heartbeat:async()=>{
    heartbeats++;return (await request('/v1/worker/heartbeat',{headers:agentHeaders,data:identity(job)})).value;
  }});
  const chunk=Buffer.alloc(1024,7), all=Buffer.alloc(20*1024,7);
  try {
    const response=await fetch(`${origin}/v1/worker/artifacts/${task.taskId}/artifact-stream-test`,{method:'POST',duplex:'half',headers:{...agentHeaders,
      'x-job-id':job.jobId,'x-boot-id':job.bootId,'x-lease-token':job.leaseToken,'x-artifact-name':'stream.bin','x-artifact-sha256':digest(all)},
      body:(async function*(){for(let i=0;i<20;i++){await delay(100);yield chunk;}})()});
    assert.equal(response.status,201,await response.text());assert.ok(heartbeats>=4);assert.equal(controller.signal.aborted,false);
    assert.equal((await request(`/v1/tasks/${task.taskId}`,{account:alice})).value.status,'RUNNING');
    await request('/v1/worker/step-result',{headers:agentHeaders,data:{...identity(job),status:'FAIL',stopConfirmed:true}});
  }finally{await stop();}
});

test('queued and running deadlines never release uncertain execution', async()=>{
  const queued=await create();
  await db.query("UPDATE tasks SET deadline_at=now()-interval '1 second' WHERE task_id=$1",[queued.taskId]);
  const active=await create(),job=await claim();
  assert.equal(job.taskId,active.taskId);
  await db.query("UPDATE tasks SET deadline_at=now()-interval '1 second' WHERE task_id=$1",[active.taskId]);
  const control=await request('/v1/worker/heartbeat',{headers:agentHeaders,data:identity(job)});
  assert.equal(control.value.action,'STOP');assert.equal(control.value.reason,'EXPIRED');
  assert.equal((await request(`/v1/tasks/${queued.taskId}`,{account:alice})).value.status,'EXPIRED');
  assert.equal((await request(`/v1/tasks/${active.taskId}`,{account:alice})).value.status,'CANCELING');
  assert.equal((await request('/v1/worker/step-result',{headers:agentHeaders,data:{...identity(job),status:'PASS',stopConfirmed:true}})).value.status,'EXPIRED');
});

test('separate enrolled workers execute only their bound users and workspaces',async()=>{
  const first=await create(), second=await create(bob);
  assert.notEqual(first.workspaceId,second.workspaceId);
  await db.query('INSERT INTO workers(worker_id,token_hash) VALUES($1,$2)',['worker-b',digest('worker-b-secret')]);
  await db.query('INSERT INTO user_worker_bindings(user_id,worker_id) VALUES($1,$2)',[bob.user.userId,'worker-b']);
  const headers={'x-worker-id':'worker-b','x-worker-token':'worker-b-secret'};
  await request('/v1/worker/register',{headers,data:{bootId:'boot-b',protocol:2}});
  const jobA=await claim();
  const jobB={...(await request('/v1/worker/poll',{headers,data:{bootId:'boot-b'}})).value.job,bootId:'boot-b'};
  assert.equal(jobA.taskId,first.taskId);assert.equal(jobB.taskId,second.taskId);
  assert.equal((await request('/v1/worker/step-result',{headers,data:{...identity(jobA),status:'FAIL',stopConfirmed:true}})).status,409);
  await request('/v1/worker/step-result',{headers:agentHeaders,data:{...identity(jobA),status:'FAIL',stopConfirmed:true}});
  await request('/v1/worker/step-result',{headers,data:{...identity(jobB),status:'FAIL',stopConfirmed:true}});
});

test('production PASS requires the packaged-game deliverable set', async () => {
  const task = await create(), job = await claim();
  const bytes = Buffer.from('{"passed":true}'), artifactId = 'artifact-production-report-only';
  const response = await fetch(`${origin}/v1/worker/artifacts/${task.taskId}/${artifactId}`, { method: 'POST', headers: {
    ...agentHeaders, 'x-job-id': job.jobId, 'x-boot-id': job.bootId, 'x-lease-token': job.leaseToken,
    'x-artifact-name': 'production-report.json', 'x-artifact-sha256': digest(bytes), 'content-type': 'application/json'
  }, body: bytes });
  assert.equal(response.status, 201, await response.text());
  const result = await request('/v1/worker/step-result', { headers: agentHeaders, data: {
    ...identity(job), status: 'PASS', stopConfirmed: true, artifactIds: [artifactId], report: { protocol: 2, production: true, passed: true }
  } });
  assert.equal(result.status, 422);
  await request('/v1/worker/step-result', { headers: agentHeaders, data: { ...identity(job), status: 'FAIL', stopConfirmed: true } });
});
