import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { finished as streamFinished } from 'node:stream/promises';

export function killProcessTree(pid) {
  if (process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', reject);
    killer.on('close', code => code === 0 ? resolve() : reject(new Error(`Process tree shutdown not confirmed (${code}).`)));
  });
}

export function runCommand(command, args, { cwd, timeoutMs, signal, input, stdoutFile, stderrFile } = {}) {
  signal?.throwIfAborted();
  return new Promise(resolve => {
    const startedAt = new Date().toISOString();
    let stdout = '', stderr = '', timedOut = false, stopping, stopError, ioError, finished = false;
    // Windows command wrappers need the native shell; keep real executables shell-free.
    const shellCommand = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command);
    const child = spawn(command, args, { cwd, windowsHide: true, shell: shellCommand, detached: process.platform !== 'win32' });
    const stop = () => {
      if (!stopping && child.pid && !finished) stopping = killProcessTree(child.pid).catch(error => { stopError = error.message; });
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs || 120000);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    const logStreams = [];
    for (const [source, file] of [[child.stdout, stdoutFile], [child.stderr, stderrFile]]) {
      if (!source || !file) continue;
      const destination = fs.createWriteStream(file);
      logStreams.push(streamFinished(destination).catch(error => { ioError = error.message; stop(); }));
      source.pipe(destination);
    }
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', data => { stdout = (stdout + data).slice(-2 * 1024 * 1024); });
    child.stderr?.on('data', data => { stderr = (stderr + data).slice(-2 * 1024 * 1024); });
    child.stdin?.on('error', error => {
      if (!['EPIPE', 'ERR_STREAM_DESTROYED'].includes(error.code)) { ioError = error.message; stop(); }
    });
    // Non-interactive tools may read until EOF even when a prompt is in argv.
    child.stdin?.end(input);
    let spawnError;
    child.on('error', error => { spawnError = error.message; });
    child.on('close', async exitCode => {
      finished = true;
      clearTimeout(timer); signal?.removeEventListener('abort', stop);
      await stopping;
      await Promise.all(logStreams);
      resolve({ command, args, startedAt, finishedAt: new Date().toISOString(), exitCode, timedOut,
        canceled: signal?.aborted || false, stdout, stderr, error: stopError || spawnError || ioError, stopConfirmed: !stopError });
    });
  });
}

export function maintainLease({ heartbeat, job, controller, intervalMs = 2000 }) {
  let until = Math.min(Date.parse(job.leaseUntil), Date.parse(job.deadlineAt)), stopped = false, timer, pending;
  const watchdog = setInterval(() => {
    if (Date.now() >= until && !controller.signal.aborted) controller.abort(new Error('Lease or task deadline expired.'));
  }, Math.min(intervalMs, 250));
  const tick = async () => {
    try {
      const response = await heartbeat();
      if (response.action === 'STOP') controller.abort(new Error(response.reason || 'Controller requested stop.'));
      else if (response.leaseUntil) until = Math.min(Date.parse(response.leaseUntil), Date.parse(job.deadlineAt));
    } catch { /* The local deadline remains authoritative while the controller is unreachable. */ }
    if (!stopped) timer = setTimeout(() => { pending = tick(); }, intervalMs);
  };
  pending = tick();
  return async () => { stopped = true; clearInterval(watchdog); clearTimeout(timer); await pending; };
}
