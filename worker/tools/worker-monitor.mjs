import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const powershell = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,
  @{n='StartedAt';e={$_.CreationDate.ToUniversalTime().ToString('o')}},
  WorkingSetSize,KernelModeTime,UserModeTime) | ConvertTo-Json -Compress`;

export function options(args, env = process.env) {
  const value = { root: env.YAHAHAGAME_WORKER_ROOT || path.join(repo, 'runtime'), interval: 2,
    control: (env.CONTROL_URL || '').replace(/\/$/, ''), workerId: env.WORKER_ID || '', token: env.WORKER_TOKEN || '' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--once', '--json', '--help'].includes(arg)) value[arg.slice(2)] = true;
    else if (['--root', '--interval'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) value[arg.slice(2)] = args[++i];
    else throw new Error(`Unknown or incomplete option: ${arg}`);
  }
  value.interval = Number(value.interval);
  if (!Number.isFinite(value.interval) || value.interval < 1 || value.interval > 3600) throw new Error('Interval must be 1-3600 seconds.');
  value.root = path.resolve(value.root);
  return value;
}

async function readJson(file, limit = 2 * 1024 ** 2) {
  const handle = await fs.open(file, 'r').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!handle) return null;
  try {
    if ((await handle.stat()).size > limit) throw new Error(`${path.basename(file)} exceeds the monitor read limit.`);
    return JSON.parse((await handle.readFile('utf8')).replace(/^\uFEFF/, ''));
  } finally { await handle.close(); }
}

export function workerTree(rows, repository = repo) {
  const target = path.win32.resolve(repository, 'worker', 'agent', 'agent.mjs').toLowerCase();
  const roots = rows.filter(row => {
    if (!/^node(?:\.exe)?$/i.test(row.Name)) return false;
    const match = (row.CommandLine || '').match(/(?:"([^"\r\n]*[\\/]agent[\\/]agent\.mjs)"|(\S*[\\/]agent[\\/]agent\.mjs))(?=\s|$)/i);
    return match && path.win32.resolve(match[1] || match[2]).toLowerCase() === target;
  });
  const selected = new Map(roots.map(row => [row.ProcessId, { ...row, depth: 0 }]));
  let added = true;
  while (added) {
    added = false;
    for (const row of rows) {
      const parent = selected.get(row.ParentProcessId);
      if (!parent || selected.has(row.ProcessId) || Date.parse(row.StartedAt) < Date.parse(parent.StartedAt)) continue;
      selected.set(row.ProcessId, { ...row, depth: parent.depth + 1 });
      added = true;
    }
  }
  return [...selected.values()].map(row => ({ pid: row.ProcessId, parentPid: row.ParentProcessId, name: row.Name,
    depth: row.depth, startedAt: row.StartedAt, memoryMB: Math.round(Number(row.WorkingSetSize || 0) / 1024 ** 2),
    cpuSeconds: Math.round((Number(row.KernelModeTime || 0) + Number(row.UserModeTime || 0)) / 1e6) / 10 }));
}

async function processes(repository = repo) {
  if (process.platform !== 'win32') throw new Error('Local process inspection requires Windows.');
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', powershell], {
    windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 ** 2, encoding: 'utf8'
  });
  const rows = JSON.parse(stdout.replace(/^\uFEFF/, '') || '[]');
  return workerTree(Array.isArray(rows) ? rows : [rows], repository);
}

export async function controllerStatus(config, signal) {
  if (!config.control || !config.workerId || !config.token) return { state: 'UNCONFIGURED', error: 'Worker controller credentials are not configured.' };
  try {
    const response = await fetch(`${config.control}/v1/worker/status`, {
      headers: { 'x-worker-id': config.workerId, 'x-worker-token': config.token },
      redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000)
    });
    if (response.status === 404) return { state: 'UNSUPPORTED', error: 'Controller status endpoint is not deployed; remote task state is unavailable.' };
    if (!response.ok) return { state: 'ERROR', error: `Controller HTTP ${response.status}` };
    const data = await response.json();
    if (data.workerId !== config.workerId || typeof data.status !== 'string') throw new Error('Invalid worker status response.');
    return { state: 'OK', ...data };
  } catch (error) { return { state: 'UNREACHABLE', error: error.message }; }
}

async function activity(directory, maxEntries = 2500) {
  const queue = [directory];
  let latest = null, visited = 0, partial = false;
  while (queue.length && visited < maxEntries) {
    const current = queue.shift();
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(error => {
      if (error.code !== 'ENOENT') partial = true;
      return [];
    });
    for (const entry of entries) {
      if (++visited > maxEntries) { partial = true; break; }
      const file = path.join(current, entry.name);
      if (entry.isDirectory() && !['.git', 'node_modules', 'DerivedDataCache', 'Intermediate'].includes(entry.name)) queue.push(file);
      else if (entry.isFile()) {
        const stat = await fs.stat(file).catch(() => null);
        if (stat && (!latest || stat.mtimeMs > latest.modifiedMs)) latest = { file, modifiedMs: stat.mtimeMs, bytes: stat.size };
      }
    }
  }
  return { latest, partial: partial || queue.length > 0 };
}

async function logTail(file) {
  if (!file) return null;
  const handle = await fs.open(file, 'r').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!handle) return null;
  try {
    const stat = await handle.stat(), start = Math.max(0, stat.size - 4096);
    const buffer = Buffer.alloc(Math.min(stat.size, 4096));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/);
    if (start) lines.shift();
    return { file, bytes: stat.size, modifiedMs: stat.mtimeMs, lines: lines.filter(Boolean).slice(-3) };
  } finally { await handle.close(); }
}

// Journals carry execution credentials. Project only displayable fields.
function taskSummary(job) {
  if (!job) return null;
  return { taskId: job.taskId, jobId: job.jobId, workspaceId: job.workspaceId, runId: job.runId, deadlineAt: job.deadlineAt };
}

function sameExecution(a, b) {
  return a && b && ['taskId', 'jobId', 'workspaceId', 'runId'].every(key => a[key] && a[key] === b[key]);
}

export async function snapshot(config, { inspect = processes, remote = controllerStatus, signal } = {}) {
  const warnings = [];
  let journalUnreadable = false;
  async function attempt(fn) {
    try { return await fn(); } catch (error) { warnings.push(error.message); return null; }
  }
  const deployment = await attempt(() => readJson(path.join(config.root, 'deployment.json')));
  const [tree, controller, journal] = await Promise.all([
    attempt(() => inspect(deployment?.repository || repo)), remote(config, signal),
    attempt(async () => {
      try { return await readJson(path.join(config.root, 'journal', 'execution.json')); }
      catch (error) { journalUnreadable = true; throw error; }
    })
  ]);
  const task = taskSummary(journal?.job || controller.active);
  const local = { state: tree === null || journalUnreadable ? 'UNKNOWN' : tree.some(p => p.depth === 0) ? journal?.phase || 'IDLE' : journal ? 'INTERRUPTED' : 'STOPPED',
    processes: tree || [], journalPhase: journal?.phase || null, task, resultStatus: journal?.result?.status || null,
    commit: deployment?.commit || null, step: null, activity: null, logs: [] };
  if (journal?.bootId && controller.bootId && journal.bootId !== controller.bootId) warnings.push('Local journal and controller have different worker boot IDs.');
  if (journal?.job && controller.state === 'OK' && !sameExecution(journal.job, controller.active)) warnings.push('Local journal and controller allocation differ.');
  if (tree?.filter(p => p.depth === 0).length > 1) warnings.push('Multiple worker agents are running from this repository.');
  if (task && /^[a-zA-Z0-9-]+$/.test(task.workspaceId) && /^[a-zA-Z0-9-]+$/.test(task.runId)) {
    const workspace = path.join(config.root, 'workspaces', task.workspaceId);
    const run = path.join(workspace, 'runs', task.runId);
    const files = await fs.readdir(run).catch(() => []);
    const steps = await Promise.all(files.filter(file => /^(production-orchestrator|unreal-project-validation|packaged-game-playtest)-\d+\.json$/.test(file)).map(async file => {
      const full = path.join(run, file), stat = await fs.stat(full).catch(() => null);
      return stat ? { full, mtime: stat.mtimeMs } : null;
    }));
    const latestStep = steps.filter(Boolean).sort((a, b) => b.mtime - a.mtime)[0];
    if (latestStep) {
      const step = await attempt(() => readJson(latestStep.full));
      if (step) local.step = { name: step.name, state: step.status || (step.canceled ? 'CANCELED' : step.timedOut ? 'TIMED_OUT' : step.exitCode === 0 ? 'EXITED_OK' : 'FAILED'),
        startedAt: step.startedAt, exitCode: step.exitCode, updatedAt: new Date(latestStep.mtime).toISOString() };
      const base = latestStep.full.slice(0, -5);
      local.logs.push(...(await Promise.all([attempt(() => logTail(`${base}.stdout.jsonl`)), attempt(() => logTail(`${base}.stderr.log`))])).filter(Boolean));
    }
    local.activity = await attempt(() => activity(workspace));
  }
  for (const file of [deployment?.stdout, deployment?.stderr]) {
    const log = await attempt(() => logTail(file));
    if (log) local.logs.push(log);
  }
  return { sampledAt: new Date().toISOString(), workerId: config.workerId || deployment?.workerId || 'unknown', root: config.root,
    controller, local, warnings, redactions: [config.token, journal?.job?.leaseToken].filter(Boolean) };
}

function age(value, now) {
  if (!value) return 'unknown';
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return 'unknown';
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}

export function safeOutput(value, secrets = []) {
  let text = String(value);
  for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]');
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

export function render(sample, { columns = Infinity, rows = Infinity } = {}) {
  const { controller: remote, local } = sample, now = Date.parse(sample.sampledAt);
  const lines = [`WORKER MONITOR  ${sample.sampledAt}`, `Worker: ${sample.workerId}    Local: ${local.state}`, `Runtime: ${sample.root}`];
  if (local.commit) lines.push(`Deployed commit: ${local.commit.slice(0, 12)}`);
  lines.push(remote.state === 'OK'
    ? `Controller: ${remote.status}    Heartbeat age: ${age(remote.lastSeenAt, now)}${now - Date.parse(remote.lastSeenAt) > 15000 ? ' [STALE]' : ''}    Queued: ${remote.queuedJobs}`
    : `Controller: ${remote.state}    ${remote.error}`);
  for (const warning of sample.warnings) lines.push(`WARNING: ${warning}`);
  const task = local.task || remote.active;
  const active = remote.state === 'OK' && sameExecution(task, remote.active) ? remote.active : null;
  if (task) {
    lines.push('', `Task: ${task.taskId}`, `Job: ${task.jobId}`, `Workspace: ${task.workspaceId}`, `Run: ${task.runId}`,
      `Task state (controller): ${active?.taskStatus || 'UNKNOWN'}    Journal: ${local.journalPhase || 'none'}`);
    if (active) lines.push(`Job state: ${active.jobStatus}    Lease until: ${active.leaseUntil}    Cancel reason: ${active.cancelReason || 'none'}`);
    if (local.resultStatus) lines.push(`Pending result: ${local.resultStatus}`);
    if (local.step) lines.push(`Step: ${local.step.name}    ${local.step.state}    Updated ${age(local.step.updatedAt, now)} ago`);
    const latest = local.activity?.latest;
    if (latest) lines.push(`File activity: ${age(latest.modifiedMs, now)} ago${now - latest.modifiedMs > 300000 ? ' [QUIET > 5m]' : ''}`,
      `  ${path.relative(sample.root, latest.file)} (${latest.bytes} bytes)`);
    if (local.activity?.partial) lines.push('File scan is partial (entry limit or inaccessible directory).');
  } else lines.push('', 'Task: none recorded locally' + (remote.state === 'OK' ? '; controller allocation: none' : ''));
  lines.push('', 'PROCESS TREE (CPU = cumulative seconds)', 'PID      PPID     CPU(s)   RAM(MB)  PROCESS');
  for (const p of local.processes) lines.push(`${String(p.pid).padEnd(9)}${String(p.parentPid).padEnd(9)}${String(p.cpuSeconds).padEnd(9)}${String(p.memoryMB).padEnd(9)}${'  '.repeat(Math.min(p.depth, 6))}${p.name}`);
  if (!local.processes.length) lines.push(local.state === 'UNKNOWN' ? 'Process query failed.' : 'No worker process found for this checkout.');
  for (const log of local.logs) {
    lines.push('', `LOG ${path.basename(log.file)} | ${log.bytes} bytes | updated ${age(log.modifiedMs, now)} ago`);
    for (const line of log.lines) lines.push(`  ${safeOutput(line, sample.redactions).slice(0, 300)}`);
  }
  lines.push('', 'Ctrl+C: close this monitor.');
  let visible = safeOutput(lines.join('\n'), sample.redactions).split('\n');
  const limit = Math.max(4, rows - 1);
  if (visible.length > limit) visible = [...visible.slice(0, limit - 2), '... more details available with -Once', visible.at(-1)];
  return visible.map(line => {
    let clipped = '', width = 0;
    for (const char of line.replace(/\t/g, ' ')) {
      const size = char.codePointAt(0) > 127 ? 2 : 1;
      if (width + size > columns - 3) return `${clipped}...`;
      clipped += char; width += size;
    }
    return clipped;
  }).join('\n');
}

export async function monitor(config) {
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    do {
      const sample = await snapshot(config, { signal: shutdown.signal });
      if (shutdown.signal.aborted) break;
      if (config.json) {
        const { redactions, ...publicSample } = sample;
        process.stdout.write(safeOutput(JSON.stringify(publicSample), redactions) + '\n');
      } else {
        if (process.stdout.isTTY && !config.once) process.stdout.write('\x1b[2J\x1b[H');
        const terminal = process.stdout.isTTY && !config.once ? { columns: process.stdout.columns, rows: process.stdout.rows } : {};
        process.stdout.write(render(sample, terminal) + '\n');
      }
      if (config.once) break;
      await delay(config.interval * 1000, undefined, { signal: shutdown.signal }).catch(error => { if (!shutdown.signal.aborted) throw error; });
    } while (!shutdown.signal.aborted);
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const config = options(process.argv.slice(2));
    if (config.help) console.log('worker-monitor.mjs [--root PATH] [--interval SECONDS] [--once] [--json]\nOn Windows use worker/deploy/monitor-worker.ps1 to load runtime configuration.');
    else await monitor(config);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
