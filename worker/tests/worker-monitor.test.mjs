import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { controllerStatus, monitor, options, render, safeOutput, snapshot, workerTree } from '../tools/worker-monitor.mjs';

const exec = promisify(execFile);
const chinese = '\u4e2d\u6587';
const token = 'private-worker-token', leaseToken = 'private-lease-token';
const job = { taskId: 'task-a', jobId: 'job-a', workspaceId: 'workspace-a', runId: 'run-a', leaseToken };
const inspect = async () => [{ pid: 123, parentPid: 1, name: 'node.exe', depth: 0, cpuSeconds: 3, memoryMB: 30 }];
const unsupported = async () => ({ state: 'UNSUPPORTED', error: 'Status endpoint is not deployed.' });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `worker monitor ${chinese} `));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'journal'));
  return root;
}
async function journal(root, phase = 'RUNNING') {
  await fs.writeFile(path.join(root, 'journal/execution.json'), JSON.stringify({ phase, bootId: 'boot-a', job,
    ...(phase === 'RESULT' ? { result: { status: 'CANCELED' } } : {}) }));
}

test('snapshot follows running, pending result, idle and stopped states without writing runtime data', async t => {
  const root = await fixture(t), config = { root, token, workerId: 'worker-a' };
  await journal(root);
  const run = path.join(root, 'workspaces/workspace-a/runs/run-a');
  await fs.mkdir(run, { recursive: true });
  await fs.writeFile(path.join(run, 'unreal-project-validation-1.json'), JSON.stringify({ name: 'unreal-project-validation-1', status: 'RUNNING' }));
  await fs.writeFile(path.join(run, 'unreal-project-validation-1.stdout.jsonl'), `${chinese} ${token} ${leaseToken}\n`);
  const before = await fs.readFile(path.join(root, 'journal/execution.json'), 'utf8');
  let sample = await snapshot(config, { inspect, remote: unsupported });
  assert.equal(sample.local.state, 'RUNNING');
  assert.equal(sample.local.task.taskId, job.taskId);
  assert.equal(sample.local.task.leaseToken, undefined);
  assert.equal(sample.local.step.name, 'unreal-project-validation-1');
  assert.ok(sample.local.activity.latest.file.startsWith(run));
  const output = render(sample);
  assert.ok(output.includes(chinese));
  assert.ok(!output.includes(token));
  assert.ok(!output.includes(leaseToken));
  assert.match(output, /Task state \(controller\): UNKNOWN/);
  const compact = render(sample, { columns: 80, rows: 24 });
  assert.ok(compact.split('\n').length <= 23);
  assert.ok(compact.split('\n').every(line => line.length <= 80));
  assert.match(compact, /Worker: worker-a/);
  assert.match(compact, /Task: task-a/);
  assert.match(compact, /Ctrl\+C: close this monitor/);
  assert.equal(await fs.readFile(path.join(root, 'journal/execution.json'), 'utf8'), before);
  sample = await snapshot(config, { inspect: async () => [], remote: unsupported });
  assert.equal(sample.local.state, 'INTERRUPTED');
  await journal(root, 'RESULT');
  sample = await snapshot(config, { inspect, remote: unsupported });
  assert.equal(sample.local.state, 'RESULT');
  assert.equal(sample.local.resultStatus, 'CANCELED');
  await fs.rm(path.join(root, 'journal/execution.json'));
  sample = await snapshot(config, { inspect, remote: unsupported });
  assert.equal(sample.local.state, 'IDLE');
  sample = await snapshot(config, { inspect: async () => [], remote: unsupported });
  assert.equal(sample.local.state, 'STOPPED');
});

test('snapshot locates the worker in the deployed Git worktree', async t => {
  const root = await fixture(t), repository = path.join(root, 'deployments', 'revision');
  await fs.writeFile(path.join(root, 'deployment.json'), JSON.stringify({ repository, commit: 'revision' }));
  let inspected;
  const sample = await snapshot({ root }, {
    inspect: async value => { inspected = value; return inspect(); }, remote: unsupported
  });
  assert.equal(inspected, repository);
  assert.equal(sample.local.state, 'IDLE');
  assert.equal(sample.local.commit, 'revision');
});

test('a stale journal never borrows status or lease details from a follow-up run', async t => {
  const root = await fixture(t);
  await journal(root, 'RESULT');
  const sample = await snapshot({ root }, {
    inspect,
    remote: async () => ({ state: 'OK', status: 'ONLINE', active: {
      ...job, jobId: 'job-b', runId: 'run-b', taskStatus: 'RUNNING', jobStatus: 'RUNNING',
      leaseUntil: '2026-09-18T00:00:00Z'
    } })
  });
  assert.deepEqual(sample.warnings, ['Local journal and controller allocation differ.']);
  assert.equal(sample.local.task.runId, 'run-a');
  const output = render(sample);
  assert.match(output, /Task state \(controller\): UNKNOWN/);
  assert.doesNotMatch(output, /Job state:|Lease until:/);
});

test('unreadable journals and failed process queries stay unknown instead of reporting idle', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'journal/execution.json'), 'invalid JSON');
  let sample = await snapshot({ root }, { inspect, remote: unsupported });
  assert.equal(sample.local.state, 'UNKNOWN');
  assert.equal(sample.warnings.length, 1);
  await fs.rm(path.join(root, 'journal/execution.json'));
  sample = await snapshot({ root }, { inspect: async () => { throw new Error('Access denied'); }, remote: unsupported });
  assert.equal(sample.local.state, 'UNKNOWN');
  assert.deepEqual(sample.warnings, ['Access denied']);
});

test('process tree matches the deployed checkout with spaces and excludes other workers and reused parents', () => {
  const repository = `D:\\${chinese} game`;
  const rows = [
    { ProcessId: 10, ParentProcessId: 1, Name: 'node.exe', CommandLine: `node "${repository}\\worker\\deploy\\..\\agent\\agent.mjs"`, StartedAt: '2026-09-17T00:00:00Z' },
    { ProcessId: 11, ParentProcessId: 10, Name: 'node.exe', CommandLine: 'codex.js secret', StartedAt: '2026-09-17T00:00:01Z' },
    { ProcessId: 12, ParentProcessId: 11, Name: 'codex.exe', CommandLine: 'secret', StartedAt: '2026-09-17T00:00:02Z' },
    { ProcessId: 13, ParentProcessId: 10, Name: 'unrelated.exe', StartedAt: '2026-09-16T00:00:00Z' },
    { ProcessId: 20, ParentProcessId: 1, Name: 'node.exe', CommandLine: 'node D:\\old\\worker\\agent\\agent.mjs' }
  ];
  const tree = workerTree(rows, repository);
  assert.deepEqual(tree.map(p => p.pid), [10, 11, 12]);
  assert.deepEqual(tree.map(p => p.depth), [0, 1, 2]);
  assert.equal(JSON.stringify(tree).includes('secret'), false);
});

test('monitor HTTP requests are read-only, detect cancellation and recover from unsupported/unavailable status', async t => {
  let status = 404;
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    assert.equal(req.headers['x-worker-token'], token);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ workerId: 'worker-a', status: 'ONLINE', lastSeenAt: '2026-09-17T00:00:00Z',
      active: { ...job, leaseToken: undefined, taskStatus: 'CANCELING', jobStatus: 'CANCELING' }, queuedJobs: 2 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const root = await fixture(t), config = { root, control: `http://127.0.0.1:${server.address().port}`, workerId: 'worker-a', token };
  assert.equal((await controllerStatus(config)).state, 'UNSUPPORTED');
  status = 503;
  assert.equal((await controllerStatus(config)).state, 'ERROR');
  status = 200;
  await journal(root);
  const sample = await snapshot(config, { inspect });
  assert.equal(sample.controller.state, 'OK');
  assert.match(render(sample), /Task state \(controller\): CANCELING/);
  assert.match(render(sample), /STALE/);
  assert.deepEqual(requests, Array(3).fill({ method: 'GET', url: '/v1/worker/status' }));
  const aborted = new AbortController(); aborted.abort();
  assert.equal((await controllerStatus(config, aborted.signal)).state, 'UNREACHABLE');
});

test('render removes terminal control sequences and CLI validates explicit paths and polling interval', () => {
  assert.equal(safeOutput(`hello\x1b[2J ${token}\x07`, [token]), 'hello[2J [REDACTED]');
  const root = path.join(os.tmpdir(), `${chinese} with spaces`);
  assert.equal(options(['--root', root, '--once', '--json'], {}).root, root);
  assert.throws(() => options(['--interval', '0'], {}), /Interval/);
  assert.throws(() => options(['--root'], {}), /incomplete/);
});

test('PowerShell -File launcher uses checkout runtime despite legacy environment and preserves Chinese paths', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t);
  const deploy = path.join(root, 'worker/deploy'), tools = path.join(root, 'worker/tools'), config = path.join(root, 'runtime/config');
  for (const dir of [deploy, tools, config]) await fs.mkdir(dir, { recursive: true });
  const launcher = path.join(deploy, 'monitor-worker.ps1');
  await fs.copyFile(fileURLToPath(new URL('../deploy/monitor-worker.ps1', import.meta.url)), launcher);
  await fs.writeFile(path.join(config, 'worker.env.ps1'), "$env:WORKER_ID = 'fixture-worker'\n$env:WORKER_TOKEN = 'fixture-secret'\n");
  await fs.writeFile(path.join(tools, 'worker-monitor.mjs'), "console.log(JSON.stringify({args:process.argv.slice(2),workerId:process.env.WORKER_ID,hasToken:process.env.WORKER_TOKEN==='fixture-secret'}));");
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher, '-Once', '-Json', '-IntervalSeconds', '3'], {
    env: { ...process.env, YAHAHAGAME_WORKER_ROOT: 'D:\\old runtime' }, windowsHide: true
  });
  const value = JSON.parse(stdout);
  assert.deepEqual(value.args, ['--root', path.join(root, 'runtime'), '--interval', '3', '--once', '--json']);
  assert.equal(value.workerId, 'fixture-worker');
  assert.equal(value.hasToken, true);
  assert.equal(stdout.includes('fixture-secret'), false);
});

test('foreground monitor refreshes repeatedly and SIGINT closes only the monitor', async t => {
  const root = await fixture(t), monitorModule = fileURLToPath(new URL('../tools/worker-monitor.mjs', import.meta.url));
  const child = spawn(process.execPath, [monitorModule, '--root', root, '--interval', '1', '--json'], {
    env: { ...process.env, WORKER_TOKEN: '', CONTROL_URL: '' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exit; });
  let output = '';
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Monitor did not refresh twice')), 20000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.stdout.on('data', bytes => {
      output += bytes.toString('utf8');
      if (output.trim().split('\n').length >= 2) { clearTimeout(timeout); resolve(); }
    });
  });
  const samples = output.trim().split('\n').map(JSON.parse);
  assert.notEqual(samples[0].sampledAt, samples[1].sampledAt);
  assert.ok(samples.every(s => s.controller.state === 'UNCONFIGURED' && !('redactions' in s)));
  // Windows kill(SIGINT) is forced termination, so exercise the installed handler
  // in-process as well without sending a console event to unrelated workers.
  child.kill('SIGINT');
  await exit;
  const listeners = process.listenerCount('SIGINT');
  const timer = setTimeout(() => process.emit('SIGINT'), 100);
  try { await monitor({ root, interval: 1, json: true }); }
  finally { clearTimeout(timer); }
  assert.equal(process.listenerCount('SIGINT'), listeners);
});
