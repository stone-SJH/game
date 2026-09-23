import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { startDatabase, availablePort } from './database-fixture.mjs';
import { createServer } from '../api/server.mjs';
import { createInvite } from '../api/accounts.mjs';
import { digest, migrate } from '../api/database.mjs';
import { MAX_REFERENCE_BYTES, expirePendingReferences } from '../api/references.mjs';
import { executeJob, runAgent } from '../../worker/agent/agent.mjs';

let fixture, db, server, origin, alice, bob, referenceRoot, workerRoot;
const agentHeaders = { 'x-worker-id': 'reference-worker', 'x-worker-token': 'reference-worker-secret' };
const auth = account => ({ origin, cookie: account.cookie, 'x-csrf-token': account.csrfToken });
async function request(route, { account, data, method = data ? 'POST' : 'GET', headers = {} } = {}) {
  const response = await fetch(origin + route, { method, headers: { origin, 'content-type': 'application/json',
    ...(account ? auth(account) : {}), ...headers }, body: data ? JSON.stringify(data) : undefined });
  return { status: response.status, value: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function upload(name, bytes, account = alice, contentType = 'application/octet-stream') {
  const response = await fetch(origin + '/v1/references', { method: 'POST', headers: { ...auth(account),
    'x-file-name': encodeURIComponent(name), 'content-type': contentType }, body: bytes });
  return { status: response.status, value: await response.json() };
}
async function create(references, account = alice) {
  return request('/v1/tasks', { account, data: { objective: 'Use the supplied references to build the scene', references } });
}
before(async () => {
  fixture = await startDatabase(); db = fixture.db;
  referenceRoot = path.join(fixture.root, 'references'); workerRoot = path.join(fixture.root, 'worker 中文');
  origin = `http://127.0.0.1:${await availablePort()}`;
  server = createServer({ db, origin, artifactRoot: path.join(fixture.root, 'artifacts'), referenceRoot, secureCookies: false });
  await new Promise(resolve => server.listen(Number(new URL(origin).port), '127.0.0.1', resolve));
  for (const name of ['reference-alice', 'reference-bob']) {
    const result = await request('/v1/auth/register', { data: { username: name, password: 'reference-test-password', code: await createInvite(db) } });
    assert.equal(result.status, 200);
    const account = { ...result.value, cookie: result.cookie };
    if (name.endsWith('alice')) alice = account; else bob = account;
  }
  await db.query('INSERT INTO workers(worker_id,token_hash) VALUES($1,$2)', [agentHeaders['x-worker-id'], digest(agentHeaders['x-worker-token'])]);
  await db.query('INSERT INTO user_worker_bindings(user_id,worker_id) VALUES($1,$2)', [alice.user.userId, agentHeaders['x-worker-id']]);
  await migrate(db);
});
after(async () => {
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await fixture?.close();
  if (fixture) await fs.rm(fixture.root, { recursive: true, force: true });
});

test('uploads enforce auth, CSRF, names and the exact 20 MiB boundary including chunked bodies', async () => {
  assert.equal((await fetch(origin + '/v1/references', { method: 'POST', body: 'x' })).status, 401);
  assert.equal((await fetch(origin + '/v1/references', { method: 'POST', headers: { ...auth(alice), 'x-csrf-token': 'bad' }, body: 'x' })).status, 403);
  assert.equal((await upload('../bad.log', 'x')).status, 400);
  assert.equal((await upload('C:\\bad.log', 'x')).status, 400);
  const accepted = await upload('exact-limit.bin', Buffer.alloc(MAX_REFERENCE_BYTES, 42));
  assert.equal(accepted.status, 201);
  assert.equal(accepted.value.sizeBytes, MAX_REFERENCE_BYTES);
  assert.equal((await upload('too-large.bin', Buffer.alloc(MAX_REFERENCE_BYTES + 1))).status, 413);
  const chunks = Readable.from((async function* () { for (let i = 0; i < 21; i++) yield Buffer.alloc(1024 * 1024); })());
  const streamed = await fetch(origin + '/v1/references', { method: 'POST', duplex: 'half', headers: { ...auth(alice),
    'x-file-name': 'chunked.bin', 'content-type': 'application/octet-stream' }, body: chunks });
  assert.equal(streamed.status, 413, await streamed.text());
  assert.equal((await db.query('SELECT count(*)::int AS count FROM task_references')).rows[0].count, 1);
  assert.deepEqual(await fs.readdir(referenceRoot), [accepted.value.referenceId]);
  await request(`/v1/references/${accepted.value.referenceId}`, { account: alice, method: 'DELETE' });
  const empty = await upload('empty.log', Buffer.alloc(0), alice, 'text/plain; charset=utf-8');
  assert.equal(empty.status, 201); assert.equal(empty.value.sizeBytes, 0); assert.equal(empty.value.contentType, 'text/plain');
  await request(`/v1/references/${empty.value.referenceId}`, { account: alice, method: 'DELETE' });
});

test('owner-only references are frozen with prompts and downloaded/consumed by the real worker execution path across continuations', async t => {
  const fixtures = [
    ['参考.png', 'image/png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVUcAAAAASUVORK5CYII=', 'base64')],
    ['日志.log', 'text/plain', Buffer.from('ERROR: collision at scene gate\n')],
    ['clip.mp4', 'video/mp4', Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50])],
    ['data.bin', 'application/octet-stream', Buffer.from([0, 255, 1, 2])],
    ['notes.txt', 'text/plain', Buffer.from('Use a red door')],
  ];
  const uploaded = [];
  for (const [name, type, bytes] of fixtures) {
    const result = await upload(name, bytes, alice, type);
    assert.equal(result.status, 201); assert.equal(result.value.sha256, digest(bytes)); uploaded.push(result.value);
  }
  const ids = uploaded.map(item => item.referenceId);
  const extra = (await upload('next.log', 'follow-up data')).value;
  assert.equal((await create([...ids, extra.referenceId])).status, 400);
  assert.equal((await create([ids[0], ids[0]])).status, 400);
  assert.equal((await create([ids[0]], bob)).status, 400);
  assert.equal((await request(`/v1/references/${ids[0]}`, { account: bob })).status, 404);
  assert.equal((await fetch(origin + `/v1/references/${ids[0]}`)).status, 401);
  const own = await fetch(origin + `/v1/references/${ids[0]}`, { headers: auth(alice) });
  assert.equal(own.headers.get('content-disposition').startsWith('attachment;'), true);
  assert.deepEqual(Buffer.from(await own.arrayBuffer()), fixtures[0][2]);
  const created = await create(ids); assert.equal(created.status, 201); const task = created.value;
  assert.equal((await create([ids[0]])).status, 400);
  await request(`/v1/references/${ids[0]}`, { account: alice, method: 'DELETE' });
  assert.equal((await db.query('SELECT 1 FROM task_references WHERE reference_id=$1', [ids[0]])).rowCount, 1);
  const revision = (await db.query('SELECT * FROM task_revisions WHERE task_id=$1', [task.taskId])).rows[0];
  assert.equal(revision.input.references.length, 5);
  assert.deepEqual(revision.input.references, revision.input.payload.references);
  assert.equal(revision.input.references[0].taskRevision, 1);
  assert.equal('storage_path' in revision.input.references[0], false);
  assert.equal((await request(`/v1/tasks/${task.taskId}`, { account: alice })).value.references.length, 5);
  await request('/v1/worker/register', { headers: agentHeaders, data: { protocol: 2, bootId: 'old-worker' } });
  assert.equal((await request('/v1/worker/poll', { headers: agentHeaders, data: { bootId: 'old-worker' } })).value.job, null);

  // The CLI probe actually reads every local file from production-context.json.
  // It deliberately creates no game, so normal production acceptance must fail.
  const cli = path.join(fixture.root, 'reference-reader.mjs');
  await fs.writeFile(cli, `import fs from 'node:fs/promises'; import path from 'node:path';
    const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk);
    const prompt=Buffer.concat(chunks).toString('utf8');
    const context=JSON.parse(await fs.readFile('plan/production-context.json','utf8'));
    const references=[]; for (const ref of context.references) {
      if (!prompt.includes(ref.localPath)) throw new Error('Reference missing from prompt');
      references.push({...ref,hex:(await fs.readFile(path.resolve(ref.localPath))).toString('hex')});
    }
    const result=JSON.stringify({prompt,references}); console.log(result);
    await fs.writeFile(process.argv[process.argv.indexOf('-o')+1],result);
  `);
  const env = { CODEX_CMD: cli, CODEX_MAX_ATTEMPTS: '1', CODEX_TIMEOUT_MS: '10000' };
  const priorEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(priorEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  let downloads = 0, leaseHeaders;
  async function run(runId, expected) {
    const result = await runAgent({ control: origin, workerId: agentHeaders['x-worker-id'], token: agentHeaders['x-worker-token'],
      root: workerRoot, signal: new AbortController().signal, once: true, intervalMs: 100,
      execute: async (job, ctx) => {
        const bootId = (await db.query('SELECT boot_id FROM workers WHERE worker_id=$1', [agentHeaders['x-worker-id']])).rows[0].boot_id;
        leaseHeaders = { ...agentHeaders, 'x-job-id': job.jobId, 'x-boot-id': bootId, 'x-lease-token': job.leaseToken };
        const route = `/v1/worker/references/${task.taskId}/${ids[0]}`;
        assert.equal((await fetch(origin + route, { headers: { ...leaseHeaders, 'x-lease-token': 'stale' } })).status, 409);
        assert.equal((await fetch(origin + route, { headers: { ...leaseHeaders, 'x-worker-token': 'wrong' } })).status, 401);
        const pending = (await upload('unattached.txt', 'not part of the task')).value;
        const unavailable = await ctx.downloadReference(pending);
        assert.equal(unavailable.status, 404); await unavailable.body.cancel();
        return executeJob(job, { ...ctx, downloadReference: ref => { downloads++; return ctx.downloadReference(ref); } });
      } });
    assert.equal(result.status, 'FAIL'); assert.match(result.reason, /Production deliverables missing/);
    const output = path.join(workerRoot, 'workspaces', task.workspaceId, 'runs', runId, 'production-orchestrator-1.json');
    const received = JSON.parse(JSON.parse(await fs.readFile(output, 'utf8')).stdout);
    assert.equal(received.references.length, expected.length);
    assert.deepEqual(received.references.map(item => item.hex), expected.map(bytes => bytes.toString('hex')));
    assert.equal((await fetch(origin + `/v1/worker/references/${task.taskId}/${ids[0]}`, { headers: leaseHeaders })).status, 409);
    return received;
  }
  const received = await run(task.runId, fixtures.map(item => item[2]));
  assert.equal(downloads, 5);
  assert.ok(received.prompt.includes('User reference files'));
  assert.equal((await request(`/v1/tasks/${task.taskId}/rerun`, { account: alice,
    data: { prompt: 'Reject six new files', references: [...ids, extra.referenceId] } })).status, 400);
  const continuation = await request(`/v1/tasks/${task.taskId}/rerun`, { account: alice, data: { prompt: 'Repair using the new log', references: [extra.referenceId] } });
  assert.equal(continuation.status, 202);
  // Lose an old local file: the next run must recover it from the controller.
  await fs.rm(path.join(workerRoot, 'workspaces', task.workspaceId, 'project', received.references[0].localPath));
  const next = await run(continuation.value.runId, [...fixtures.map(item => item[2]), Buffer.from('follow-up data')]);
  assert.equal(downloads, 7);
  assert.ok(next.prompt.includes('Repair using the new log')); assert.equal(next.references.at(-1).taskRevision, 2);
  const view = (await request(`/v1/tasks/${task.taskId}`, { account: alice })).value;
  assert.equal(view.references.length, 6); assert.equal(view.runs[0].references.length, 1); assert.equal(view.runs[1].references.length, 5);
  assert.deepEqual((await db.query('SELECT input_hash FROM task_revisions WHERE revision_id=$1', [revision.revision_id])).rows[0].input_hash, revision.input_hash);
  const textOnly = await request(`/v1/tasks/${task.taskId}/rerun`, { account: alice, data: { prompt: 'Keep all previous references' } });
  assert.equal(textOnly.status, 202);
  assert.equal((await request(`/v1/tasks/${task.taskId}`, { account: alice })).value.references.length, 6);
  await request(`/v1/tasks/${task.taskId}/cancel`, { account: alice, data: {} });
});

test('expired and discarded pending uploads are cleaned without deleting bound references', async () => {
  const pending = (await upload('expired.txt', 'expire me')).value;
  await db.query("UPDATE task_references SET created_at=now()-interval '25 hours'");
  assert.equal((await create([pending.referenceId])).status, 400);
  await expirePendingReferences(db);
  assert.equal((await db.query('SELECT 1 FROM task_references WHERE task_id IS NULL')).rowCount, 0);
  const bound = (await db.query('SELECT storage_path FROM task_references WHERE task_id IS NOT NULL')).rows;
  assert.equal(bound.length, 6);
  for (const row of bound) assert.ok((await fs.stat(row.storage_path)).isFile());
});
