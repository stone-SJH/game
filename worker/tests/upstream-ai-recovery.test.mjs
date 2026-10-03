import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { executeJob } from '../agent/agent.mjs';
import { createExecutionStore } from '../agent/modeling-execution.mjs';
import { codexServiceSession } from '../agent/codex-service-session.mjs';
import { normalizeProgress } from '../../controller/api/tasks.mjs';

const threadId = '00000000-0000-4000-8000-000000000001';
const name = 'modeling-author-fixture-final-author-1';
async function fixture(t, mode = 'recover', recovery = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-recovery '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = path.join(root, 'fake-codex.mjs'), records = path.join(root, 'calls.jsonl');
  await fs.writeFile(script, `
import fs from 'node:fs';
const args = process.argv.slice(2), mode = ${JSON.stringify(mode)}, records = ${JSON.stringify(records)};
let input = ''; for await (const chunk of process.stdin) input += chunk;
fs.appendFileSync(records, JSON.stringify({ args, input }) + '\\n');
const calls = fs.readFileSync(records, 'utf8').trim().split('\\n').length;
const send = event => console.log(JSON.stringify(event));
if (mode !== 'missing-session') send({type:'thread.started',thread_id:${JSON.stringify(threadId)}});
if (calls === 1) {
  if (mode === 'quoted-503') send({type:'item.completed',item:{id:'read-contract',type:'command_execution',
    command:'Get-Content production-contract.md',exit_code:0,status:'completed',
    aggregated_output:'Authentication/configuration errors and ENOSPC stop new tool work.'}});
  const item = { id:'tool-1',type:mode === 'file-change' ? 'file_change' : 'mcp_tool_call',server:'yahaha_blender',tool:'blender_run_python' };
  send({type:'item.started',item});
  fs.writeFileSync('source.blend', 'saved-once', {flag:'wx'});
  if (mode !== 'unfinished-tool') send({type:'item.completed',item:{...item,status:'completed'}});
}
if (calls < 3 || !['recover', 'quoted-503'].includes(mode)) {
  const message = mode === 'auth' ? 'HTTP 401 authentication failed' : mode === 'quoted-503' ? 'HTTP 503 Service Unavailable' : calls === 1 ? 'exceeded retry limit, last status: 429 Too Many Requests' : 'stream disconnected before completion';
  send({type:'turn.failed',error:{message}}); process.exitCode = 1;
} else {
  if (!args.includes('resume') || args[args.indexOf('resume') + 1] !== ${JSON.stringify(threadId)}) throw new Error('Wrong session');
  if (fs.readFileSync('source.blend','utf8') !== 'saved-once') throw new Error('Lost completed work');
  send({type:'turn.completed'});
}
`);
  const progress = [], waits = [], controller = new AbortController();
  let time = Date.now();
  const context = { root, signal: controller.signal,
    reportProgress: value => progress.push(normalizeProgress(value)),
    serviceRecoveryOptions: { now: () => time, wait: async ms => { waits.push(ms); time += ms; }, ...recovery },
    productionHarness: async ({ step, project }) => {
      const execution = createExecutionStore(path.join(root, 'execution'));
      await execution.run({ key: 'author', stage: 'AUTHOR', timeoutMs: 120000, maxCalls: 1 }, () =>
        step(name, process.execPath, [script, 'exec', '--json', '--ephemeral', '--cd', project,
          '--sandbox', 'read-only', '-c', 'mcp_servers={}', '--output-schema', 'schema.json', '-o', 'response.txt', '--image', 'reference.png', '-'],
        120000, project, undefined, { input: 'Original author task' }));
      return { files: {}, qualityAccepted: false, delivery: { iteration: 1, score: 0, threshold: 85, playable: false } };
    } };
  return { root, records, progress, waits, controller, context,
    run: () => executeJob({ taskId: 'task', workspaceId: 'workspace', runId: 'run', objective: 'Fixture' }, context) };
}

test('429 after Blender work and a later stream failure resume the same stage without replaying tools or spending another author call', async t => {
  const f = await fixture(t);
  assert.equal((await f.run()).status, 'PASS');
  const calls = (await fs.readFile(f.records, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => !call.args.includes('--ephemeral')));
  assert.equal(calls[0].input, 'Original author task');
  for (const call of calls.slice(1)) {
    assert.deepEqual(call.args.slice(-3), ['resume', threadId, '-']);
    assert.match(call.input, /continue only unfinished work/);
    assert.ok(!call.args.includes('--image'));
    for (const flag of ['--sandbox', '--output-schema', '-o', '--cd', '-c']) assert.ok(call.args.includes(flag));
  }
  assert.deepEqual(f.waits, [5000, 10000]);
  const state = JSON.parse(await fs.readFile(path.join(f.root, 'execution/execution.json'), 'utf8'));
  const group = Object.values(state.groups)[0];
  assert.equal(group.calls.length, 1); assert.equal(group.completed, true);
  assert.ok(f.progress.some(p => p.phase === 'waiting_service' && p.status === 'running' && p.nextRetryAt));
  assert.ok(f.progress.every(p => !p.error && !p.diagnostic && p.status !== 'failed'));
  assert.equal(f.progress.at(-1).waitReason, null);
  const output = path.join(f.root, 'workspaces/workspace/runs/run');
  assert.match(await fs.readFile(path.join(output, name + '.stdout.jsonl'), 'utf8'), /429/);
  assert.match(await fs.readFile(path.join(output, name + '-service-2.stdout.jsonl'), 'utf8'), /stream disconnected/);
  assert.match(await fs.readFile(path.join(output, name + '-service-3.stdout.jsonl'), 'utf8'), /turn.completed/);
});

test('503 after reading a contract mentioning ENOSPC resumes the same conversation within the existing author budget', async t => {
  const f = await fixture(t, 'quoted-503');
  assert.equal((await f.run()).status, 'PASS');
  const calls = (await fs.readFile(f.records, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 3);
  for (const call of calls.slice(1)) assert.deepEqual(call.args.slice(-3), ['resume', threadId, '-']);
  assert.deepEqual(f.waits, [5000, 10000]);
  assert.equal(await fs.readFile(path.join(f.root, 'workspaces/workspace/project/source.blend'), 'utf8'), 'saved-once');
  const ledger = JSON.parse(await fs.readFile(path.join(f.root, 'execution/execution.json'), 'utf8'));
  const group = Object.values(ledger.groups)[0];
  assert.equal(group.calls.length, 1);
  assert.equal(group.completed, true);
  assert.ok(f.progress.some(p => p.phase === 'waiting_service' && p.nextRetryAt));
  const stateRoot = path.join(f.root, 'workspaces/workspace/service-state');
  const [stateFile] = await fs.readdir(stateRoot);
  const state = JSON.parse(await fs.readFile(path.join(stateRoot, stateFile), 'utf8'));
  assert.equal(state.attempts, 3);
  assert.equal(state.waitedMs, 15000);
});

for (const mode of ['auth', 'missing-session', 'unfinished-tool']) test(`${mode} cannot replay a tool-bearing invocation`, async t => {
  const f = await fixture(t, mode);
  assert.equal((await f.run()).status, 'FAIL');
  assert.equal((await fs.readFile(f.records, 'utf8')).trim().split('\n').length, 1);
  assert.equal(f.waits.length, 0);
});

test('service exhaustion is bounded and preserves completed file changes and terminal diagnostics', async t => {
  const f = await fixture(t, 'file-change', { maxWaitMs: 5000 });
  const result = await f.run();
  assert.equal(result.status, 'FAIL');
  assert.match(result.reason, /响应流中断/);
  assert.equal((await fs.readFile(f.records, 'utf8')).trim().split('\n').length, 2);
  assert.equal(await fs.readFile(path.join(f.root, 'workspaces/workspace/project/source.blend'), 'utf8'), 'saved-once');
  assert.ok(f.progress.at(-1).diagnostic.logFiles[0].includes('-service-2'));
});

test('a task deadline reached during backoff cannot launch another AI process', async t => {
  const f = await fixture(t);
  const original = f.context.serviceRecoveryOptions.now();
  let time = original;
  f.context.serviceRecoveryOptions.now = () => time;
  f.context.serviceRecoveryOptions.wait = async () => { time += 200000; };
  assert.equal((await f.run()).status, 'FAIL');
  assert.equal((await fs.readFile(f.records, 'utf8')).trim().split('\n').length, 1);
});

test('cancellation during backoff does not resume the conversation', async t => {
  const f = await fixture(t);
  f.context.serviceRecoveryOptions.wait = async () => { f.controller.abort(new Error('Operator pause')); };
  await assert.rejects(f.run(), /Operator pause/);
  assert.equal((await fs.readFile(f.records, 'utf8')).trim().split('\n').length, 1);
});

test('unknown child shutdown and canceled/timed out commands never resume', () => {
  const session = codexServiceSession(['exec', '--json', '--ephemeral', '-']);
  session.observe({ type: 'thread.started', thread_id: threadId });
  for (const result of [{ stopConfirmed: false }, { stopConfirmed: true, canceled: true }, { stopConfirmed: true, timedOut: true }]) assert.equal(session.retrySafe(result), false);
  session.observe({ type: 'item.completed', item: { id: 'mcp', type: 'mcp_tool_call', result: { content: [{ type: 'text', text: '{"stopConfirmed":false}' }] } } });
  assert.equal(session.retrySafe({ stopConfirmed: true }), false);
});
