import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { materializeReferences } from '../agent/references.mjs';
import { executeJob } from '../agent/agent.mjs';

function reference(bytes, name = '参考 file.log', taskRevision = 1) {
  return { referenceId: `reference-${crypto.randomUUID()}`, name, taskRevision, sizeBytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), contentType: 'application/octet-stream' };
}
async function setup(t) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'worker references 中文 '));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  return { project, signal: new AbortController().signal };
}

test('references are verified, cached, and repaired across runs without name collisions', async t => {
  const ctx = await setup(t), bytes = Buffer.from('reference contents'), first = reference(bytes), second = reference(bytes, first.name, 2);
  let downloads = 0;
  const input = { ...ctx, references: [first, second], downloadReference: async () => { downloads++; return new Response(bytes); } };
  const files = await materializeReferences(input);
  assert.notEqual(files[0].localPath, files[1].localPath);
  for (const file of files) assert.deepEqual(await fs.readFile(path.join(ctx.project, file.localPath)), bytes);
  await materializeReferences(input);
  assert.equal(downloads, 2);
  await fs.writeFile(path.join(ctx.project, files[0].localPath), 'corrupt');
  await materializeReferences(input);
  assert.equal(downloads, 3);
  assert.deepEqual(await fs.readFile(path.join(ctx.project, files[0].localPath)), bytes);
});

test('bad hashes, truncated/oversized streams, failed downloads and cancellation cannot publish a reference', async t => {
  const ctx = await setup(t), bytes = Buffer.from('good'), item = reference(bytes);
  for (const received of ['evil', 'bad', 'too long']) {
    await assert.rejects(materializeReferences({ ...ctx, references: [item], downloadReference: async () => new Response(received) }), /integrity|size mismatch/);
    assert.deepEqual(await fs.readdir(path.join(ctx.project, 'references')), []);
  }
  await assert.rejects(materializeReferences({ ...ctx, references: [item], downloadReference: async () => new Response('gone', { status: 404 }) }), /download failed/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(materializeReferences({ ...ctx, signal: controller.signal, references: [item] }), { name: 'AbortError' });
});

test('unsafe IDs, invalid sizes and more than five files in one revision are rejected before downloading', async t => {
  const ctx = await setup(t), item = reference(Buffer.from('x'));
  for (const references of [[{ ...item, referenceId: '../../outside' }], [{ ...item, sizeBytes: 20 * 1024 ** 2 + 1 }],
    Array.from({ length: 6 }, () => reference(Buffer.from('x'))), [item, item]]) {
    await assert.rejects(materializeReferences({ ...ctx, references }), /manifest|at most 5/i);
  }
});

test('download names are safe on Windows even for reserved names and path-like metadata', async t => {
  const ctx = await setup(t), bytes = Buffer.from('data');
  const references = ['CON', 'C:\\outside\\file.log', '../../image.png', 'trailing. ', 'file.txt:stream'].map(name => reference(bytes, name));
  const files = await materializeReferences({ ...ctx, references, downloadReference: async () => new Response(bytes) });
  for (const file of files) {
    assert.equal(path.win32.dirname(file.localPath), 'references');
    assert.match(path.win32.basename(file.localPath), /^reference-[a-f0-9-]{36}(?:\.[a-z0-9]{1,12})?$/);
    assert.deepEqual(await fs.readFile(path.join(ctx.project, file.localPath)), bytes);
  }
});

test('reference directory symlinks and Windows junctions cannot escape the workspace', async t => {
  const ctx = await setup(t), outside = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-references-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(ctx.project, 'references'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(materializeReferences({ ...ctx, references: [reference(Buffer.from('x'))] }), /inside the task workspace/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('cancellation during streaming removes partial downloads', async t => {
  const ctx = await setup(t), controller = new AbortController();
  let canceled = false;
  const timer = setTimeout(() => controller.abort(), 50);
  try {
    await assert.rejects(materializeReferences({ ...ctx, signal: controller.signal, references: [reference(Buffer.from('hello'))],
      downloadReference: async () => new Response(new ReadableStream({
        start(stream) { stream.enqueue(Buffer.from('he')); }, cancel() { canceled = true; },
      })) }), { name: 'AbortError' });
  } finally { clearTimeout(timer); }
  assert.equal(canceled, true);
  assert.deepEqual(await fs.readdir(path.join(ctx.project, 'references')), []);
});

test('executeJob reports invalid reference bytes before starting the production harness', async t => {
  const ctx = await setup(t);
  const result = await executeJob({ taskId: 'task', workspaceId: 'workspace', runId: 'run', objective: 'Read the reference',
    payload: { references: [reference(Buffer.from('good'))] } }, {
    root: ctx.project, signal: ctx.signal, downloadReference: async () => new Response('evil'), uploadFile: async name => name,
  });
  assert.equal(result.status, 'FAIL'); assert.match(result.reason, /integrity check failed/);
  assert.equal(await fs.stat(path.join(ctx.project, 'workspaces/workspace/project/plan/production-context.json')).catch(() => null), null);
});
