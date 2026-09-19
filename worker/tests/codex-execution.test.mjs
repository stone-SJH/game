import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { archivePackage, executeJob } from '../agent/agent.mjs';
import { codexInvocation, commandDiagnostic, projectValidationArgs } from '../agent/production-harness.mjs';
import { runProductionHarness } from '../agent/production-harness.mjs';
import { runCommand } from '../agent/process-runner.mjs';

const chinese = '\u4e2d\u6587\u6218\u6597\u573a\u666f';
const objective = `${chinese} with spaces\nsecond line\r\n"quoted" & | < > ^ %PATH% !VAR! $(literal) \\`;

test('Unreal project validation uses a real package-loading commandlet', () => {
  assert.deepEqual(projectValidationArgs('D:/workspace/Warden.uproject'), [
    '-project=D:/workspace/Warden.uproject', '-run=LoadPackage', '-all', '-projectonly', '-fast',
    '-unattended', '-nop4', '-nosplash', '-nullrhi', '-NoSound',
  ]);
});

test('command diagnostics include process errors, stderr, and stdout', () => {
  const diagnostic = commandDiagnostic({ error: 'spawn failed', stderr: 'cleanup warning', stdout: '503 Service Unavailable' });
  assert.match(diagnostic, /process error:\nspawn failed/);
  assert.match(diagnostic, /stderr:\ncleanup warning/);
  assert.match(diagnostic, /stdout:\n503 Service Unavailable/);
});

test('playable package archive contains the complete packaged directory', async t => {
  const root = await fixture(t);
  const packageRoot = path.join(root, 'package', 'Windows');
  const archive = path.join(root, 'playable.zip');
  await fs.mkdir(path.join(packageRoot, 'Warden', 'Content'), { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'Warden.exe'), 'launcher');
  await fs.writeFile(path.join(packageRoot, 'Warden', 'Content', 'game.pak'), 'content');
  await archivePackage(packageRoot, archive, new AbortController().signal);
  const listing = await runCommand(process.platform === 'win32' ? '7z.exe' : 'tar', process.platform === 'win32' ? ['l', '-ba', path.basename(archive)] : ['-tf', path.basename(archive)], { cwd: path.dirname(archive), timeoutMs: 10000 });
  assert.equal(listing.exitCode, 0, listing.stderr);
  assert.match(listing.stdout, /Warden\.exe/);
  assert.match(listing.stdout, /game\.pak/);
});

test('playable checkpoint is published before a later acceptance failure', async t => {
  const root = await fixture(t);
  const project = path.join(root, 'project');
  const output = path.join(root, 'run');
  const skill = path.join(root, 'skill.md');
  const packageFile = path.join(project, 'package', 'Windows', 'Game.exe');
  const stages = ['intake-and-contract', 'project-bootstrap', 'art-direction-and-asset-plan', 'asset-production-and-import',
    'level-blockout-and-traversal', 'gameplay-foundation-and-input', 'camera-combat-ai-and-feel',
    'world-materials-fx-audio-and-ui', 'integration-build-and-playtest', 'package-and-acceptance'];
  await fs.writeFile(skill, 'fixture skill');
  environment(t, { YAHAHA_PRODUCTION_SKILL: skill, CODEX_MAX_ATTEMPTS: '1', CODEX_RETRY_DELAY_MS: '1' });
  const checkpoints = [];
  const step = async name => {
    if (name.startsWith('production-orchestrator')) {
      await fs.mkdir(path.dirname(packageFile), { recursive: true });
      await fs.writeFile(path.join(project, 'Game.uproject'), '{}');
      await fs.writeFile(path.join(project, 'scene-preview.png'), 'preview');
      await fs.writeFile(packageFile, 'game');
      await fs.mkdir(path.join(project, 'provenance'), { recursive: true });
      await fs.mkdir(path.join(project, 'plan'), { recursive: true });
      await fs.mkdir(path.join(project, 'acceptance'), { recursive: true });
      await fs.writeFile(path.join(project, 'workspace-manifest.json'), '{}');
      await fs.writeFile(path.join(project, 'provenance', 'asset-manifest.json'), '{}');
      await fs.writeFile(path.join(project, 'plan', 'stage-manifest.json'), JSON.stringify({ stages: stages.map(id => ({ id, status: 'ACCEPTED' })) }));
      await fs.writeFile(path.join(project, 'acceptance', 'playtest-evidence.json'), '{}');
      await fs.writeFile(path.join(project, 'acceptance', 'acceptance-report.json'), JSON.stringify({ protocol: 1, passed: false, criteria: [{ status: 'FAIL' }] }));
      for (const stage of stages) {
        const directory = path.join(project, 'stages', stage);
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, 'stage-report.json'), JSON.stringify({ status: 'ACCEPTED' }));
        await fs.writeFile(path.join(directory, 'evidence.json'), JSON.stringify({ criteria: [{ status: 'PASS' }] }));
      }
    }
    return { exitCode: 0, timedOut: false, error: null, stderr: '', stdout: '', stopConfirmed: true };
  };
  await assert.rejects(runProductionHarness({
    job: { taskId: 'task', runId: 'run', workspaceId: 'workspace', objective: 'fixture' }, project, output,
    signal: new AbortController().signal, step, unreal: 'UnrealEditor-Cmd.exe', reportProgress: async () => {},
    onIterationPackage: async value => checkpoints.push(value),
  }), /Acceptance report does not prove|retry budget exhausted/);
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].attempt, 1);
  assert.equal(checkpoints[0].packageFile, packageFile);
});

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

async function fakeCli(root, { exitCode = 0, delayMs = 0, stderr = '', recordEnvironment = false } = {}) {
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
    const record = { args, input, cwd: process.cwd(), ...(${recordEnvironment ? 'true' : 'false'} ? { temp: process.env.TEMP, tmp: process.env.TMP, tmpdir: process.env.TMPDIR } : {}) };
    console.log(JSON.stringify(record));
    if (args.includes('-o')) await fs.writeFile(args[args.indexOf('-o') + 1], input);
    if (${exitCode} === 2) console.error("error: unexpected argument 'are' found");
    if (${JSON.stringify(stderr)}) console.error(${JSON.stringify(stderr)});
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
  const uploads = [];
  const result = await executeJob(job, { root, signal: new AbortController().signal,
    uploadFile: async (name, file, contentType, options) => { uploads.push({ name, options }); return name; } });
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
  assert.deepEqual(uploads.find(item => item.name === 'iteration-monitor-1.json')?.options, { timeoutMs: 10000 });
  const report = JSON.parse(await fs.readFile(path.join(output, 'production-report.json'), 'utf8'));
  assert.equal(report.iterationReviews[0].action, 'stop');
  assert.ok(result.artifactIds.includes('iteration-monitor-1.json'));
});

test('production Codex attempts use an isolated temporary directory', async t => {
  const root = await fixture(t), { entrypoint } = await fakeCli(root, { recordEnvironment: true });
  environment(t, { CODEX_CMD: entrypoint, CODEX_MAX_ATTEMPTS: '1', CODEX_TIMEOUT_MS: '10000' });
  const job = { taskId: 'temp-task', workspaceId: 'temp-workspace', runId: 'run', objective };
  await executeJob(job, { root, signal: new AbortController().signal, uploadFile: async name => name });
  const output = path.join(root, 'workspaces', job.workspaceId, 'runs', job.runId);
  const record = JSON.parse((await fs.readFile(path.join(output, 'production-orchestrator-1.stdout.jsonl'), 'utf8')));
  assert.ok(record.temp && record.tmp && record.tmpdir);
  assert.equal(record.temp, record.tmp);
  assert.equal(record.temp, record.tmpdir);
  assert.equal(path.dirname(record.temp), path.resolve(os.tmpdir()));
  assert.notEqual(record.temp, process.env.TEMP);
});

test('service failures with cleanup warnings use bounded retries and publish the actual cause', async t => {
  const root = await fixture(t), { entrypoint } = await fakeCli(root, {
    exitCode: 1,
    stderr: 'WARNING: failed to clean up stale arg0 temp dirs: The directory is not empty. (os error 145)\nHTTP 503 Service Unavailable',
    recordEnvironment: true,
  });
  environment(t, { CODEX_CMD: entrypoint, CODEX_MAX_ATTEMPTS: '0', CODEX_RETRY_DELAY_MS: '1', CODEX_TIMEOUT_MS: '10000',
    ITERATION_SAME_FAILURE_LIMIT: '3', ITERATION_FAILURE_LIMIT: '8' });
  const job = { taskId: 'temp-failure-task', workspaceId: 'temp-failure-workspace', runId: 'run', objective };
  const result = await executeJob(job, { root, signal: new AbortController().signal, uploadFile: async name => name });
  assert.equal(result.status, 'FAIL');
  assert.match(result.reason, /Iteration monitor stopped at iteration 3/);
  assert.match(result.reason, /503 Service Unavailable/);
  const output = path.join(root, 'workspaces', job.workspaceId, 'runs', job.runId);
  assert.equal((await fs.readdir(output)).filter(file => /^production-orchestrator-\d+\.json$/.test(file)).length, 3);
  const report = JSON.parse(await fs.readFile(path.join(output, 'production-report.json'), 'utf8'));
  assert.deepEqual(report.iterationReviews.map(review => [review.category, review.action, review.aiInvoked]),
    [['service', 'retry', false], ['service', 'retry', false], ['service', 'stop', false]]);
  const temps = new Set();
  for (let attempt = 1; attempt <= 3; attempt++) {
    const record = JSON.parse(await fs.readFile(path.join(output, `production-orchestrator-${attempt}.stdout.jsonl`), 'utf8'));
    temps.add(record.temp);
    await assert.rejects(fs.stat(record.temp), { code: 'ENOENT' });
  }
  assert.equal(temps.size, 3);
});

test('telemetry includes the newest workspace files beyond the first directory entries', async t => {
  const root = await fixture(t), { entrypoint } = await fakeCli(root, { exitCode: 2 });
  environment(t, { CODEX_CMD: entrypoint, CODEX_MAX_ATTEMPTS: '1' });
  const job = { taskId: 'recent-task', workspaceId: 'existing-workspace', runId: 'next-run', objective };
  const project = path.join(root, 'workspaces', job.workspaceId, 'project');
  await fs.mkdir(project, { recursive: true });
  for (let index = 0; index < 40; index++) {
    const file = path.join(project, `asset-${String(index).padStart(2, '0')}.uasset`);
    await fs.writeFile(file, 'existing project data');
    await fs.utimes(file, 1000 + index, 1000 + index);
  }
  const latest = path.join(project, 'zzz-latest.umap');
  await fs.writeFile(latest, 'latest scene');
  const progress = [];
  await executeJob(job, { root, signal: new AbortController().signal, uploadFile: async name => name,
    reportProgress: value => progress.push(value) });
  assert.ok(progress.some(value => value.projectFiles.some(file => file.name === 'zzz-latest.umap')));
  assert.ok(progress.every(value => value.projectFiles.length <= 30));
  assert.equal(await fs.readFile(latest, 'utf8'), 'latest scene');
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
