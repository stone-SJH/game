import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from '../api/server.mjs';
import { digest } from '../api/database.mjs';

test('worker status authenticates its own identity, exposes no credentials and performs only reads', async t => {
  const token = 'worker-a-secret', queries = [];
  const row = { worker_id: 'worker-a', status: 'ONLINE', boot_id: 'boot-a', token_hash: digest(token),
    last_seen_at: '2026-09-17T00:00:00Z', capabilities: {}, queued_jobs: '2', allocation_id: 'allocation-a',
    allocation_job_id: 'job-a', allocation_workspace_id: 'workspace-a', allocation_boot_id: 'boot-a',
    write_epoch: '1', task_id: 'task-a', run_id: 'run-a', task_status: 'CANCELING', job_status: 'CANCELING',
    lease_token: 'execution-secret', cancel_reason: 'CANCELED' };
  const db = { query: async (sql, params) => {
    queries.push({ sql, params });
    assert.match(sql, /^SELECT /);
    const authenticated = params[0] === row.worker_id && (params.length === 1 || params[1] === row.token_hash);
    return { rows: authenticated ? [row] : [] };
  } };
  const server = createServer({ db, origin: 'http://127.0.0.1', artifactRoot: '.' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/v1/worker/status`;
  for (const headers of [{}, { 'x-worker-id': 'worker-b', 'x-worker-token': token }, { 'x-worker-id': 'worker-a', 'x-worker-token': 'wrong' }]) {
    assert.equal((await fetch(url, { headers })).status, 401);
  }
  const headers = { 'x-worker-id': 'worker-a', 'x-worker-token': token };
  const response = await fetch(url, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const value = await response.json();
  assert.equal(value.workerId, 'worker-a');
  assert.equal(value.queuedJobs, 2);
  assert.equal(value.active.taskStatus, 'CANCELING');
  assert.equal(value.active.workspaceId, 'workspace-a');
  assert.equal(value.lastSeenAt, row.last_seen_at);
  assert.doesNotMatch(JSON.stringify(value), /secret|token_hash|lease_token|leaseToken/);
  assert.deepEqual(queries.at(-1).params, ['worker-a']);
  row.allocation_id = null;
  assert.equal((await (await fetch(url, { headers })).json()).active, null);
});
