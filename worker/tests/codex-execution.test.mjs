import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { executeJob } from '../agent/agent.mjs';
import { codexInvocation } from '../agent/production-harness.mjs';
import { runCommand } from '../agent/process-runner.mjs';

const chinese = '\u4e2d\u6587\u6218\u6597\u573a\u666f';
const objective = `${chinese} with spaces\nsecond line\r\n"quoted" & | < > ^ %PATH% !VAR! $(literal) \\`;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'worker invocation '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, `${chinese} with spaces`);
  await fs.mkdir(directory);
  return directory;
}

function environment(t, values) {
  const prior = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

async function fakeCli(root, { exitCode = 0, delayMs = 0 } = {}) {
  const packageRoot = path.join(root, 'node_modules', '@openai', 'codex');
  const entrypoint = path.join(packageRoot, 'bin', 'codex.mjs');
  await fs.mkdir(path.dirname(entrypoint), { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: '@openai/codex', bin: { codex: 'bin/codex.mjs' },
  }));
  const wrapper = path.join(root, 'codex.cmd');
  await fs.writeFile(wrapper, '@echo off\r\necho SHELL_SHIM_MUST_NOT_RUN\r\nexit /b 99\r\n');
  await fs.writeFile(entrypoint, `
    import fs from 'node:fs/promises';
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const input = Buffer.concat(chunks).toString('utf8');
    const args = process.argv.slice(2);
    const record = { args, input, cwd: process.cwd() };
    console.log(JSON.stringify(record));
    if (args.includes('-o')) await fs.writeFile(args[args.indexOf('-o') + 1], input);
    if (${exitCode} === 2) console.error("error: unexpected argument 'are' found");
    await new Promise(resolve => setTimeout(resolve, ${delayMs}));
    process.exitCode = ${exitCode};
  `);
  return { entrypoint, wrapper };
}

test('JS entrypoint preserves Chinese, multiline stdin and paths/arguments with spaces', async t => {
  const root = await fixture(t), { entrypoint } = await fakeCli(root);
  const output = path.join(root, 'last message.txt');
  const input = objective.repeat(2000); // Exceeds Windows command-line limits if put in argv.
  const args = ['exec', '--cd', root, '-o', output, 'a "quoted" argument', '', '-'];
  const invocation = codexInvocation(args, entrypoint);
  const result = await runCommand(invocation.command, invocation.args, { cwd: root, input, timeoutMs: 10000 });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.timedOut, false);
  assert.deepEqual(JSON.parse(result.stdout), { args, input, cwd: root });
  assert.equal(await fs.readFile(output, 'utf8'), input);
});

test('Windows npm shim resolves its declared JS entrypoint without running cmd.exe', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t), { wrapper } = await fakeCli(root);
  environment(t, { PATH: `${root}${path.delimiter}${process.env.PATH}` });
  for (const configured of [wrapper, 'codex.cmd']) {
    const invocation = codexInvocation(['exec', '--cd', root, '-'], configured);
    assert.equal(invocation.command, process.execPath);
    const result = await runCommand(invocation.command, invocation.args, { cwd: root, input: objective, timeoutMs: 10000 });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).input, objective);
  }
});

test('unknown Windows wrapper fails before production can enter the retry loop', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t);
  const wrapper = path.join(root, 'unknown.cmd');
  await fs.writeFile(wrapper, '@exit /b 0\r\n');
  assert.throws(() => codexInvocation([], wrapper), error => error.hardFailure === true && /CODEX_CMD/.test(error.message));
});

test('missing JS entrypoint is a configuration failure rather than an unlimited retry', async t => {
  const root = await fixture(t);
  assert.throws(() => codexInvocation([], path.join(root, 'missing.js')), error => error.hardFailure === true && /does not exist/.test(error.message));
});

test('production executeJob sends stdin, closes it, and persists step diagnostics', async t => {
  const root = await fixture(t), { entrypoint, wrapper } = await fakeCli(root);
  environment(t, { CODEX_CMD: process.platform === 'win32' ? wrapper : entrypoint, CODEX_MAX_ATTEMPTS: '1', CODEX_TIMEOUT_MS: '10000' });
  const job = { taskId: 'fixture-task', workspaceId: `workspace ${chinese}`, runId: 'run with spaces', objective };
  const result = await executeJob(job, { root, signal: new AbortController().signal, uploadFile: async name => name });
  // The fixture only checks transport; it deliberately supplies no game deliverables.
  assert.equal(result.status, 'FAIL');
  assert.match(result.reason, /Production deliverables missing/);
  const project = path.join(root, 'workspaces', job.workspaceId, 'project');
  const output = path.join(root, 'workspaces', job.workspaceId, 'runs', job.runId);
  const step = JSON.parse(await fs.readFile(path.join(output, 'production-orchestrator-1.json'), 'utf8'));
  const received = JSON.parse(step.stdout);
  assert.equal(step.exitCode, 0, step.stderr);
  assert.equal(received.args.at(-1), '-');
  assert.equal(received.args[received.args.indexOf('--cd') + 1], project);
  assert.equal(received.cwd, project);
  assert.ok(received.input.includes(`Task objective: ${objective}\n`));
  assert.equal(received.args.some(arg => arg.includes(objective)), false);
  assert.equal(await fs.readFile(path.join(output, 'codex-production-session-1.txt'), 'utf8'), received.input);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(output, 'production-orchestrator-1.stdout.jsonl'), 'utf8')), received);
});

test('CLI usage failure exits immediately with diagnostics even when retries are unlimited', async t => {
  const root = await fixture(t), { entrypoint } = await fakeCli(root, { exitCode: 2 });
  environment(t, { CODEX_CMD: entrypoint, CODEX_MAX_ATTEMPTS: '0', CODEX_RETRY_DELAY_MS: '1', CODEX_TIMEOUT_MS: '10000' });
  const job = { taskId: 'bad-cli-task', workspaceId: 'bad-cli-workspace', runId: 'run', objective };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  let result;
  try { result = await executeJob(job, { root, signal: controller.signal, uploadFile: async name => name }); }
  finally { clearTimeout(timeout); }
  assert.equal(controller.signal.aborted, false);
  assert.equal(result.status, 'FAIL');
  assert.match(result.reason, /unexpected argument 'are'/);
  const output = path.join(root, 'workspaces', job.workspaceId, 'runs', job.runId);
  const report = JSON.parse(await fs.readFile(path.join(output, 'production-report.json'), 'utf8'));
  assert.equal(report.logs.length, 1);
  assert.equal(report.logs[0].exitCode, 2);
  assert.equal(JSON.parse(await fs.readFile(path.join(output, 'codex-production-attempt-1.json'), 'utf8')).exitCode, 2);
});

test('commands with no input receive EOF instead of waiting on an open pipe', async t => {
  const root = await fixture(t), { entrypoint } = await fakeCli(root);
  const result = await runCommand(process.execPath, [entrypoint], { cwd: root, timeoutMs: 3000 });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.timedOut, false);
  assert.equal(JSON.parse(result.stdout).input, '');
});

test('stdout is available on disk before the process exits', async t => {
  const root = await fixture(t), { entrypoint } = await fakeCli(root, { delayMs: 1000 });
  const stdoutFile = path.join(root, 'stdout.jsonl');
  let exited = false;
  const running = runCommand(process.execPath, [entrypoint], { cwd: root, timeoutMs: 5000, input: objective, stdoutFile });
  running.then(() => { exited = true; });
  let output;
  try {
    for (let i = 0; i < 100; i++) {
      output = await fs.readFile(stdoutFile, 'utf8').catch(() => '');
      if (output.endsWith('\n')) break;
      await delay(10);
    }
    assert.equal(exited, false);
    assert.equal(JSON.parse(output).input, objective);
  } finally { await running; }
});

test('spawn failure and an early CLI exit do not leave stdin/log streams hanging', async t => {
  const root = await fixture(t);
  const missing = await runCommand(path.join(root, 'missing.exe'), [], {
    cwd: root, input: objective, timeoutMs: 1000, stdoutFile: path.join(root, 'missing.log'),
  });
  assert.match(missing.error, /ENOENT/);
  const early = await runCommand(process.execPath, ['-e', 'process.exit(2)'], {
    cwd: root, input: objective.repeat(100000), timeoutMs: 5000,
  });
  assert.equal(early.exitCode, 2);
  assert.equal(early.timedOut, false);
});

test('cancellation still terminates the command and its descendant after stdin EOF', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t), marker = path.join(root, 'descendants.json');
  const controller = new AbortController();
  const script = `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    process.stdin.resume();
    process.stdin.on('end', () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
      fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify([process.pid, child.pid]));
    });
    setInterval(()=>{},1000);
  `;
  const running = runCommand(process.execPath, ['-e', script], { cwd: root, signal: controller.signal, input: objective, timeoutMs: 10000 });
  let pids;
  try {
    for (let i = 0; i < 100; i++) {
      pids = await fs.readFile(marker, 'utf8').then(JSON.parse).catch(() => null);
      if (pids) break;
      await delay(20);
    }
    assert.ok(pids, 'Command consumed stdin and started its descendant');
  } finally { controller.abort(); }
  const result = await running;
  assert.equal(result.canceled, true);
  assert.equal(result.stopConfirmed, true, result.error);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0));
});
