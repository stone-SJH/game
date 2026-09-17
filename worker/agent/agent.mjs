import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runCommand, maintainLease } from './process-runner.mjs';
import { artifactContentType, runProductionHarness } from './production-harness.mjs';

async function atomicJson(file, value) {
  const temp = `${file}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(value));
  await fsp.rename(temp, file);
}

export async function executeJob(job, ctx) {
  const { root, signal, uploadFile } = ctx;
  const project = path.join(root, 'workspaces', job.workspaceId, 'project');
  const output = path.join(root, 'workspaces', job.workspaceId, 'runs', job.runId);
  await fsp.mkdir(project, { recursive: true }); await fsp.mkdir(output, { recursive: true });
  const logs = [], artifactIds = [];
  async function step(name, command, args, timeoutMs, cwd = project, accepts) {
    signal.throwIfAborted();
    const result = await runCommand(command, args, { cwd, timeoutMs, signal });
    if (!result.stopConfirmed) throw Object.assign(new Error(result.error), { stopConfirmed: false });
    signal.throwIfAborted();
    const passed = accepts ? await accepts(result) : result.exitCode === 0 && !result.timedOut;
    logs.push({ name, ...result, passed });
    if (!passed) throw Object.assign(new Error(`${name} failed.`), { result });
    return result;
  }
  const unreal = process.env.UNREAL_CMD || 'D:\\UE\\UE_5.8\\Engine\\Binaries\\Win64\\UnrealEditor-Cmd.exe';
  let failure;
  let production;
  try {
    production = await runProductionHarness({ job, project, output, signal, step, unreal });
    for (const file of Object.values(production.files)) artifactIds.push(await uploadFile(path.basename(file), file, artifactContentType(file)));
  } catch (error) {
    if (signal.aborted || error.stopConfirmed === false) throw error;
    failure = error.message;
  }
  const report = { protocol: 2, production: true, taskId: job.taskId, runId: job.runId, logs, passed: !failure, failure,
    deliverables: production ? Object.fromEntries(Object.entries(production.files).map(([role, file]) => [role, path.relative(project, file)])) : null };
  const reportName = 'production-report.json';
  const file = path.join(output, reportName);
  await atomicJson(file, report);
  artifactIds.push(await uploadFile(reportName, file, 'application/json'));
  // Full tool output lives in the streamed report artifact, not the bounded control request.
  const summary = { protocol: 2, production: true, passed: report.passed, failure, deliverables: report.deliverables,
    steps: logs.map(({ name, passed, exitCode, timedOut }) => ({ name, passed, exitCode, timedOut })) };
  return { status: failure ? 'FAIL' : 'PASS', reason: failure || 'Tool pipeline passed.', report: summary, artifactIds, stopConfirmed: true };
}

export async function runAgent({ control, workerId, token, root, signal, once = false, intervalMs = 2000, execute = executeJob }) {
  if (!token) throw new Error('A per-worker credential is required.');
  await fsp.mkdir(path.join(root, 'journal'), { recursive: true });
  const journal = path.join(root, 'journal', 'execution.json');
  const prior = await fsp.readFile(journal, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (prior?.phase === 'RUNNING') throw new Error('An interrupted execution needs process-tree verification. Do not clear its journal until shutdown is confirmed.');
  const bootId = prior?.bootId || crypto.randomUUID();
  const headers = { 'x-worker-id': workerId, 'x-worker-token': token };
  async function post(route, input) {
    const response = await fetch(control + route, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ ...input, workerId, bootId }), signal: AbortSignal.timeout(10000) });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(`${route}: ${value.error}`), { status: response.status });
    return value;
  }
  async function sendResult(job, result) {
    await atomicJson(journal, { phase: 'RESULT', bootId, job, result });
    while (true) {
      try {
        const accepted = await post('/v1/worker/step-result', { ...result, ...identity(job) });
        await fsp.rm(journal, { force: true });
        return accepted;
      } catch (error) {
        if (error.status === 422) { result = { ...result, status: 'FAIL', reason: error.message }; await atomicJson(journal, { phase: 'RESULT', bootId, job, result }); }
        else if (signal?.aborted || [400, 401, 403, 409].includes(error.status)) throw error;
        await delay(intervalMs);
      }
    }
  }
  const identity = job => ({ jobId: job.jobId, taskId: job.taskId, leaseToken: job.leaseToken });
  await post('/v1/worker/register', { protocol: 2, capabilities: { platform: process.platform, node: process.version, productionHarness: 1, requiredOutputs: ['uproject', 'scene-preview', 'packaged-exe', 'acceptance-report'] } });
  if (prior) await sendResult(prior.job, prior.result);
  console.log(`worker ${workerId} registered (protocol 2)`);
  while (!signal?.aborted) {
    let job;
    try {
      await post('/v1/worker/heartbeat', {});
      ({ job } = await post('/v1/worker/poll', {}));
    } catch (error) {
      if ([400, 401, 403, 409].includes(error.status)) throw error;
      if (signal?.aborted) break;
      await delay(intervalMs); continue;
    }
    if (!job) { if (once) return null; await delay(intervalMs); continue; }
    const controller = new AbortController();
    const abort = () => controller.abort(new Error('Worker shutting down.'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const stopLease = maintainLease({ job, controller, intervalMs, heartbeat: () => post('/v1/worker/heartbeat', identity(job)) });
    await atomicJson(journal, { phase: 'RUNNING', bootId, job });
    let result;
    try {
      result = await execute(job, { root, signal: controller.signal, uploadFile: async (name, file, contentType) => {
        controller.signal.throwIfAborted();
        const hash = crypto.createHash('sha256');
        for await (const chunk of fs.createReadStream(file, { signal: controller.signal })) hash.update(chunk);
        const sha = hash.digest('hex');
        const artifactId = `artifact-${crypto.createHash('sha256').update(`${job.jobId}:${name}:${sha}`).digest('hex')}`;
        const response = await fetch(`${control}/v1/worker/artifacts/${job.taskId}/${artifactId}`, { method: 'POST', duplex: 'half',
          headers: { ...headers, 'x-boot-id': bootId, 'x-job-id': job.jobId, 'x-lease-token': job.leaseToken, 'x-artifact-name': name, 'x-artifact-sha256': sha, 'content-type': contentType },
          body: fs.createReadStream(file), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60 * 60000)]) });
        if (!response.ok) throw new Error(`Artifact upload failed (${response.status}).`);
        return (await response.json()).artifactId;
      } });
    } catch (error) {
      result = { status: controller.signal.aborted ? 'CANCELED' : 'FAIL', reason: error.message, artifactIds: [], stopConfirmed: error.stopConfirmed !== false };
    }
    try { await sendResult(job, result); } finally { await stopLease(); signal?.removeEventListener('abort', abort); }
    if (once) return result;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const shutdown = new AbortController();
  process.on('SIGINT', () => shutdown.abort()); process.on('SIGTERM', () => shutdown.abort());
  runAgent({ control: (process.env.CONTROL_URL || 'http://139.224.32.61').replace(/\/$/, ''), workerId: process.env.WORKER_ID || 'yahahagame-sandbox-0',
    token: process.env.WORKER_TOKEN, root: process.env.YAHAHAGAME_WORKER_ROOT || fileURLToPath(new URL('../../runtime/', import.meta.url)), signal: shutdown.signal,
    intervalMs: Number(process.env.POLL_INTERVAL_MS || 2000) }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
