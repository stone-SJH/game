import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createArtifactPublisher, awaitArtifactPublication } from '../agent/artifact-publication.mjs';
import { executeJob, runAgent } from '../agent/agent.mjs';
import http from 'node:http';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-publication-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'artifact.json'); await fs.writeFile(source, '{}');
  return { root, source, file: path.join(root, 'publication.json'), retryDelayMs: 0, signal: new AbortController().signal };
}

test('publication outages retain a durable queue and resume without rebuilding or reuploading success', async t => {
  const f = await fixture(t); let calls = 0;
  const first = await createArtifactPublisher({ ...f, upload: async () => { calls++; throw new Error('HTTP 503'); } });
  assert.equal(await first.publish('artifact', f.source, 'application/json'), null);
  assert.equal(calls, 3); assert.equal(first.summary().status, 'PENDING');
  const resumed = await createArtifactPublisher({ ...f, upload: async () => { calls++; return 'artifact-id'; } });
  await resumed.flush(); assert.equal(calls, 4);
  assert.equal(resumed.summary().status, 'PUBLISHED');
  assert.equal(await resumed.publish('artifact', f.source, 'application/json'), 'artifact-id');
  assert.equal(calls, 4);
});

test('unreadable publication input remains pending and a restored file can publish', async t => {
  const f = await fixture(t); let calls = 0;
  await fs.rm(f.source);
  const publisher = await createArtifactPublisher({ ...f, upload: async () => { calls++; return 'artifact'; } });
  await publisher.publish('artifact', f.source, 'application/json');
  assert.equal(calls, 0); assert.equal(publisher.summary().pending.length, 1);
  await fs.writeFile(f.source, '{}'); await publisher.flush();
  assert.equal(calls, 1); assert.equal(publisher.summary().status, 'PUBLISHED');
});

test('final artifact and report upload failures preserve the completed production result', async t => {
  const f = await fixture(t); let builds = 0;
  const job = { taskId: 'publication-task', workspaceId: 'workspace', runId: 'run', objective: 'Build a game' };
  const result = await executeJob(job, { root: f.root, signal: f.signal, publicationRetryDelayMs: 0,
    uploadFile: async () => { throw new Error('HTTP 503'); },
    productionHarness: async () => { builds++; return { files: { packageFile: f.source }, qualityAccepted: false,
      delivery: { iteration: 1, score: 60, threshold: 85, status: 'DELIVERED_WITH_GAPS', playable: true } }; } });
  assert.equal(builds, 1); assert.equal(result.status, 'PASS');
  assert.equal(result.report.delivery.playable, true); assert.equal(result.report.qualityAccepted, false);
  assert.equal(result.report.publication.status, 'PENDING');
  assert.ok(result.report.publication.pending.some(item => item.name === 'production-report.json'));
  assert.deepEqual(result.artifactIds, []);
  assert.equal(await fs.readFile(f.source, 'utf8'), '{}');
});

test('publication never swallows cancellation or unconfirmed process stop', async t => {
  const f = await fixture(t);
  const publisher = await createArtifactPublisher({ ...f, upload: async () => { throw Object.assign(new Error('stop uncertain'), { stopConfirmed: false }); } });
  await assert.rejects(publisher.publish('artifact', f.source, 'application/json'), error => error.stopConfirmed === false);
});

test('pending publication survives edits to the source and waits for delivery without rebuilding', async t => {
  const f = await fixture(t); let online = false, pending = 0, received;
  const publisher = await createArtifactPublisher({ ...f, maxAttempts: 1, upload: async (name, file) => {
    if (!online) throw new Error('offline'); received = await fs.readFile(file, 'utf8'); return 'artifact';
  } });
  await publisher.publish('artifact', f.source, 'application/json', { required: true });
  await fs.writeFile(f.source, 'next iteration');
  await awaitArtifactPublication(publisher, { signal: f.signal, retryDelayMs: 0, onPending: async () => { pending++; online = true; } });
  assert.equal(pending, 1); assert.equal(received, '{}');
  assert.equal(publisher.summary().status, 'PUBLISHED');
});

test('live worker retains PASS through controller 422 and renews its lease while retrying acceptance', async t => {
  const f = await fixture(t), submissions = []; let issued = false, builds = 0;
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const send = (code, body) => { response.writeHead(code, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (request.url.endsWith('/register')) return send(200, {});
    if (request.url.endsWith('/heartbeat')) return send(200, { leaseUntil: new Date(Date.now() + 60000).toISOString() });
    if (request.url.endsWith('/poll')) {
      const job = issued ? null : { taskId: 't', jobId: 'j', workspaceId: 'w', runId: 'r', leaseToken: 'fixture',
        leaseUntil: new Date(Date.now() + 60000).toISOString(), deadlineAt: new Date(Date.now() + 120000).toISOString() };
      issued = true; return send(200, { job });
    }
    if (request.url.endsWith('/step-result')) {
      submissions.push(input);
      return submissions.length === 1 ? send(422, { error: 'Verified artifact temporarily unavailable' }) : send(200, { accepted: true });
    }
    send(404, {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await runAgent({ control: `http://127.0.0.1:${server.address().port}`, workerId: 'fixture', token: 'fixture',
    root: f.root, once: true, intervalMs: 5, signal: f.signal,
    execute: async (job, ctx) => { builds++; assert.equal(ctx.requirePublishableResult, true);
      return { status: 'PASS', report: { passed: true }, artifactIds: ['artifact'], stopConfirmed: true }; } });
  assert.equal(builds, 1); assert.equal(result.status, 'PASS');
  assert.deepEqual(submissions.map(item => item.status), ['PASS', 'PASS']);
  assert.match(submissions[1].publicationError, /artifact/);
  await assert.rejects(fs.stat(path.join(f.root, 'journal/execution.json')), { code: 'ENOENT' });
});

test('optional evidence outage does not delay retrying required artifacts', async t => {
  const f = await fixture(t); let optionalCalls = 0, online = false;
  const publisher = await createArtifactPublisher({ ...f, maxAttempts: 1, upload: async name => {
    if (name === 'optional') { optionalCalls++; throw new Error('optional backend offline'); }
    if (!online) throw new Error('required backend offline'); return 'required-id';
  } });
  await publisher.publish('optional', f.source, 'application/json');
  await publisher.publish('required', f.source, 'application/json', { required: true });
  await awaitArtifactPublication(publisher, { signal: f.signal, retryDelayMs: 0, onPending: () => { online = true; } });
  assert.equal(optionalCalls, 1); assert.equal(publisher.summary().requiredPending, 0);
  assert.deepEqual(publisher.summary().pending.map(item => item.name), ['optional']);
});

test('live completion waits for the complete archive and required report without rerunning production', async t => {
  const f = await fixture(t); let builds = 0, archives = 0, reportUploads = 0, reportPublished = false;
  const progress = [], uploaded = [];
  const job = { taskId: 'publication-task', workspaceId: 'workspace', runId: 'run', objective: 'Build a game' };
  const result = await executeJob(job, { root: f.root, signal: f.signal, requirePublishableResult: true,
    publicationRetryDelayMs: 0,
    reportProgress: async value => { progress.push(value.phase); if (value.phase === 'completed') assert.equal(reportPublished, true); },
    archivePackage: async (source, destination) => {
      archives++; if (archives === 1) throw new Error('archive file locked');
      assert.equal(source, path.dirname(f.source)); await fs.writeFile(destination, 'complete archive with dependencies');
    },
    uploadFile: async (name, file) => {
      if (name === 'production-report.json' && ++reportUploads <= 3) throw new Error('report endpoint offline');
      if (name === 'production-report.json') reportPublished = true;
      uploaded.push({ name, content: await fs.readFile(file, 'utf8') }); return name;
    },
    productionHarness: async () => { builds++; return { files: { packageFile: f.source }, qualityAccepted: false,
      delivery: { iteration: 1, score: 60, threshold: 85, status: 'DELIVERED_WITH_GAPS', playable: true } }; },
  });
  assert.equal(builds, 1); assert.equal(archives, 2); assert.equal(reportUploads, 4);
  assert.equal(result.status, 'PASS'); assert.equal(result.report.publication.requiredPending, 0);
  assert.ok(uploaded.some(item => item.content === 'complete archive with dependencies'));
  assert.equal(progress.at(-1), 'completed');
});
