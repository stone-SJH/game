import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startDatabase, availablePort } from './database-fixture.mjs';
import { createServer } from '../api/server.mjs';
import { createInvite } from '../api/accounts.mjs';
import { digest, migrate } from '../api/database.mjs';
import { createUserDecisions } from '../../worker/agent/modeling-user-decisions.mjs';
import { atomicJson } from '../../worker/agent/modeling-io.mjs';

let fixture, db, server, origin, alice, bob;
const workerId = 'decision-worker', workerToken = 'test-only-worker-token', bootId = 'decision-boot';
const headers = { 'x-worker-id': workerId, 'x-worker-token': workerToken };
async function request(route, { account, data, extra = {}, method } = {}) {
  const response = await fetch(origin + route, { method: method || (data ? 'POST' : 'GET'), headers: {
    origin, 'content-type': 'application/json', ...(account ? { cookie: account.cookie, 'x-csrf-token': account.csrfToken } : {}), ...extra,
  }, body: data ? JSON.stringify(data) : undefined });
  return { status: response.status, value: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
const identity = job => ({ taskId: job.taskId, jobId: job.jobId, bootId, leaseToken: job.leaseToken });
async function registerWorker(capabilities = { userDecisions: 1 }) {
  assert.equal((await request('/v1/worker/register', { extra: headers, data: { bootId, protocol: 2, capabilities } })).status, 200);
}
async function waiting() {
  await registerWorker();
  const created = await request('/v1/tasks', { account: alice, data: { objective: 'Create a stylized woodland game.' } });
  assert.equal(created.status, 201);
  const { job } = (await request('/v1/worker/poll', { extra: headers, data: { bootId } })).value;
  assert.equal(job.taskId, created.value.taskId); assert.equal(job.controllerCapabilities.userDecisions, 1);
  const root = path.join(fixture.root, job.workspaceId), project = path.join(root, 'project'), output = path.join(root, 'output');
  await atomicJson(path.join(project, 'plan/modeling-plan.json'), { assets: [{ assetId: 'fox', prompt: 'Silver woodland fox' }] });
  const manager = createUserDecisions({ job, project, output });
  const question = await manager.fromGeneration({ blockedAssets: [{ assetId: 'fox', issues: [{ stage: 'concept-image',
    input: { prompt: 'One detailed silver woodland fox.', referenceImages: [], provider: 'image-router' },
    response: { code: 'moderation_blocked', requestId: 'test-provider-request' } }] }] });
  const result = { ...identity(job), status: 'FAIL', stopConfirmed: true, report: { passed: false, inputRequest: question } };
  const posted = await request('/v1/worker/step-result', { extra: headers, data: result });
  assert.equal(posted.status, 200, JSON.stringify(posted.value)); assert.equal(posted.value.status, 'WAITING_FOR_INPUT');
  return { job, question, result };
}
function answer(question, overrides = {}) {
  return { requestId: question.requestId, revisionId: question.revisionId, basePlanHash: question.basePlanHash,
    effectiveInputHash: question.effectiveInputHash, optionId: 'revise-design', text: 'An original copper colored woodland creature, four legs and rounded ears.',
    referencePaths: [], grantNewBudget: false, idempotencyKey: 'answer-request-0001', ...overrides };
}
before(async () => {
  fixture = await startDatabase(); db = fixture.db;
  origin = `http://127.0.0.1:${await availablePort()}`;
  server = createServer({ db, origin, artifactRoot: path.join(fixture.root, 'artifacts'), secureCookies: false, maxUsers: 3, leaseMs: 60000 });
  await new Promise(resolve => server.listen(Number(new URL(origin).port), '127.0.0.1', resolve));
  for (const username of ['alice', 'bob']) {
    const result = await request('/v1/auth/register', { data: { username, password: 'testing-password-123', code: await createInvite(db) } });
    const account = { ...result.value, cookie: result.cookie };
    if (username === 'alice') alice = account; else bob = account;
  }
  await db.query('INSERT INTO workers(worker_id,token_hash) VALUES($1,$2)', [workerId, digest(workerToken)]);
  await db.query('INSERT INTO user_worker_bindings(user_id,worker_id) VALUES($1,$2)', [alice.user.userId, workerId]);
});
after(async () => {
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await fixture?.close();
});

test('question publication is durable and idempotent; pending tasks release the worker and cannot rerun implicitly', async () => {
  await migrate(db);
  const { job, question, result } = await waiting();
  const view = (await request(`/v1/tasks/${job.taskId}`, { account: alice })).value;
  assert.equal(view.status, 'WAITING_FOR_INPUT'); assert.equal(view.runs[0].status, 'WAITING_FOR_INPUT');
  assert.deepEqual(view.inputRequest, question); assert.deepEqual(view.allowedActions, ['answer', 'cancel']);
  assert.equal((await request('/v1/tasks', { account: alice })).value.tasks[0].status, 'WAITING_FOR_INPUT');
  assert.equal((await request('/v1/worker/status', { extra: headers })).value.active, null);
  assert.equal((await request('/v1/worker/step-result', { extra: headers, data: result })).value.duplicate, true);
  assert.equal((await request(`/v1/tasks/${job.taskId}/rerun`, { account: alice, data: { prompt: 'continue' } })).status, 409);
  assert.equal((await request(`/v1/tasks/${job.taskId}/recover`, { account: alice, data: { requestId: 'recover-test' } })).status, 409);
  await db.query("UPDATE tasks SET deadline_at=now()-interval '1 day' WHERE task_id=$1", [job.taskId]);
  assert.equal((await request(`/v1/tasks/${job.taskId}`, { account: alice })).value.status, 'WAITING_FOR_INPUT');
  assert.equal((await request(`/v1/tasks/${job.taskId}/cancel`, { account: alice, data: {} })).value.status, 'CANCELED');
  assert.equal((await request(`/v1/tasks/${job.taskId}/answer`, { account: alice, data: answer(question) })).status, 409);
});

test('ownership, CSRF, stale input and insufficient answers never enqueue work; duplicate answer queues once with inherited budget', async () => {
  const { job, question, result } = await waiting(), route = `/v1/tasks/${job.taskId}/answer`;
  assert.equal((await request(route, { account: bob, data: answer(question) })).status, 404);
  assert.equal((await request(route, { account: alice, extra: { 'x-csrf-token': 'wrong' }, data: answer(question) })).status, 403);
  for (const invalid of [{ text: '' }, { text: 'continue' }, { text: question.generationInput.prompt }]) {
    assert.equal((await request(route, { account: alice, data: answer(question, invalid) })).status, 422);
  }
  assert.equal((await request(route, { account: alice, data: answer(question, { basePlanHash: 'f'.repeat(64) }) })).status, 409);
  const both = await Promise.all([1, 2].map(() => request(route, { account: alice, data: answer(question) })));
  assert.deepEqual(both.map(row => row.status), [202, 202]); assert.equal(both.filter(row => row.value.duplicate).length, 1);
  assert.equal((await db.query('SELECT * FROM task_revisions WHERE task_id=$1', [job.taskId])).rowCount, 2);
  assert.equal((await request(route, { account: alice, data: answer(question, { text: 'A different, contradictory new answer.' }) })).status, 409);
  // A replayed old result must not reopen an answered question or clobber QUEUED.
  await request('/v1/worker/step-result', { extra: headers, data: result });
  assert.equal((await request(`/v1/tasks/${job.taskId}`, { account: alice })).value.status, 'QUEUED');
  await registerWorker({});
  assert.equal((await request('/v1/worker/poll', { extra: headers, data: { bootId } })).value.job, null);
  await registerWorker();
  const next = (await request('/v1/worker/poll', { extra: headers, data: { bootId } })).value.job;
  assert.equal(next.payload.budgetRevisionId, job.revisionId);
  assert.equal(next.payload.inputAnswer.request.requestId, question.requestId);
  assert.match(next.payload.followUpPrompt, /copper colored/);
  await request('/v1/worker/step-result', { extra: headers, data: { ...identity(next), status: 'FAIL', stopConfirmed: true } });
});

test('explicit budget grant creates a separate budget revision and retains question history', async () => {
  const { job, question } = await waiting();
  const response = await request(`/v1/tasks/${job.taskId}/answer`, { account: alice, data: answer(question, { grantNewBudget: true }) });
  assert.equal(response.status, 202);
  const next = (await request('/v1/worker/poll', { extra: headers, data: { bootId } })).value.job;
  assert.equal(next.payload.budgetRevisionId, next.revisionId); assert.notEqual(next.revisionId, job.revisionId);
  assert.equal(next.budgetGrant.authorCallsPerAsset, 3);
  assert.equal((await db.query('SELECT status FROM task_input_requests WHERE request_id=$1', [question.requestId])).rows[0].status, 'ANSWERED');
  await request('/v1/worker/step-result', { extra: headers, data: { ...identity(next), status: 'FAIL', stopConfirmed: true } });
});

test('browser shows actual evidence, preserves drafts after reload and errors, and resumes only on explicit submit', async t => {
  const executablePath = process.env.DECISION_TEST_BROWSER || (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : null);
  if (!executablePath || !await fs.stat(executablePath).catch(() => null)) return t.skip('Set DECISION_TEST_BROWSER to an installed Chromium browser.');
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath, headless: true }); t.after(() => browser.close());
  const { job, question } = await waiting();
  const context = await browser.newContext();
  const [name, value] = alice.cookie.split('='); await context.addCookies([{ name, value, url: origin }]);
  const page = await context.newPage();
  await page.goto(origin + '/#' + job.taskId); await page.locator('.user-decision').waitFor();
  assert.match(await page.locator('.user-decision').innerText(), /One detailed silver woodland fox/);
  assert.equal(await page.locator('.decision-form input[type=radio]:checked').count(), 0);
  assert.equal(await page.locator('[name=grant-budget]').isChecked(), false);
  await page.locator('[name=decision-text]').fill('continue');
  await page.locator('.decision-form button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('.decision-error')?.textContent.includes('complete revised'));
  await page.locator('[name=decision-text]').fill('An original copper colored fox, broad paws and rounded ears.');
  await page.reload(); await page.locator('.user-decision').waitFor();
  assert.match(await page.locator('[name=decision-text]').inputValue(), /copper colored fox/);
  assert.equal((await request(`/v1/tasks/${job.taskId}`, { account: alice })).value.inputRequest.requestId, question.requestId);
  await page.locator('.decision-form button[type=submit]').click();
  await page.waitForFunction(() => !document.querySelector('.user-decision'));
  assert.equal((await request(`/v1/tasks/${job.taskId}`, { account: alice })).value.status, 'QUEUED');
  await request(`/v1/tasks/${job.taskId}/cancel`, { account: alice, data: {} });
});
