import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runCommand, maintainLease } from './process-runner.mjs';
import { artifactContentType, commandDiagnostic, runProductionHarness } from './production-harness.mjs';

async function atomicJson(file, value) {
  const temp = `${file}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(value));
  await fsp.rename(temp, file);
}

const ignoredDirectories = new Set(['.git', 'Binaries', 'DerivedDataCache', 'Intermediate', 'node_modules']);
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const logExtensions = new Set(['.log', '.jsonl', '.txt']);
const normalizePath = value => value.split(path.sep).join('/');

export async function archivePackage(packageRoot, destination, signal) {
  await fsp.rm(destination, { force: true });
  const windows = process.platform === 'win32';
  const sevenZip = windows ? findSevenZip() : null;
  const command = sevenZip || (windows ? 'tar.exe' : 'tar');
  const extension = windows ? '.zip' : '.tar.gz';
  const temporaryName = `.yahahagame-package-${crypto.randomUUID()}${extension}`;
  const temporary = path.join(packageRoot, temporaryName);
  const args = sevenZip
    ? ['a', '-tzip', '-mx=1', temporaryName, '.', `-xr!${temporaryName}`]
    : windows
      ? ['-a', '-c', '-f', temporaryName, `--exclude=./${temporaryName}`, '.']
      : ['-czf', temporaryName, `--exclude=./${temporaryName}`, '.'];
  const result = await runCommand(command, args, {
    cwd: packageRoot,
    signal,
    timeoutMs: Number(process.env.PACKAGE_ARCHIVE_TIMEOUT_MS || 60 * 60 * 1000),
  });
  if (!result.stopConfirmed || result.error || result.exitCode !== 0 || result.timedOut) {
    await fsp.rm(temporary, { force: true });
    throw new Error(`Playable package archive failed (exit ${result.exitCode}):\n${commandDiagnostic(result)}`);
  }
  try { await fsp.rename(temporary, destination); }
  finally { await fsp.rm(temporary, { force: true }); }
  return destination;
}

function findSevenZip() {
  const candidates = [process.env.SEVEN_ZIP_EXE, '7z.exe', '7zz.exe',
    'C:\\Program Files\\7-Zip\\7z.exe', 'C:\\ProgramData\\chocolatey\\bin\\7z.exe'].filter(Boolean);
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      try { if (fs.existsSync(candidate)) return candidate; } catch { /* Try the next installation. */ }
      continue;
    }
    for (const directory of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
      const file = path.join(directory.replace(/^"|"$/g, ''), candidate);
      try { if (fs.existsSync(file)) return file; } catch { /* Try the next PATH entry. */ }
    }
  }
  return null;
}

function playablePackageName(attempt) {
  return `playable-package-iteration-${String(attempt).padStart(3, '0')}${process.platform === 'win32' ? '.zip' : '.tar.gz'}`;
}

async function recentFiles(root, predicate, limit = 30) {
  const found = [];
  async function visit(directory) {
    let entries;
    try { entries = await fsp.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) { if (!ignoredDirectories.has(entry.name)) await visit(path.join(directory, entry.name)); continue; }
      if (!entry.isFile()) continue;
      const file = path.join(directory, entry.name);
      if (!predicate(file, entry.name)) continue;
      try {
        const stat = await fsp.stat(file);
        found.push({ name: entry.name, path: normalizePath(path.relative(root, file)), size: stat.size, updatedAt: stat.mtime.toISOString() });
        found.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
        if (found.length > limit) found.pop();
      } catch { /* A file can disappear while a tool is writing it. */ }
    }
  }
  await visit(root);
  return found.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, limit);
}
async function workspaceSnapshot(project, output) {
  const projectFiles = await recentFiles(project, (file, name) => !file.split(path.sep).includes('Saved') && !logExtensions.has(path.extname(name).toLowerCase()), 30);
  const logFiles = [
    ...(await recentFiles(project, (file, name) => logExtensions.has(path.extname(name).toLowerCase()) || /log/i.test(name), 20)).map(file => ({ ...file, path: `project/${file.path}` })),
    ...(await recentFiles(output, (file, name) => logExtensions.has(path.extname(name).toLowerCase()) || /log/i.test(name), 20)).map(file => ({ ...file, path: `run/${file.path}` })),
  ].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 30);
  const screenshots = [
    ...(await recentFiles(project, (file, name) => imageExtensions.has(path.extname(name).toLowerCase()), 12)).map(file => ({ ...file, path: `project/${file.path}` })),
    ...(await recentFiles(output, (file, name) => imageExtensions.has(path.extname(name).toLowerCase()), 12)).map(file => ({ ...file, path: `run/${file.path}` })),
  ].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 20);
  return { projectFiles, logFiles, screenshots };
}
function phaseForStep(name) {
  if (name.startsWith('iteration-diagnosis')) return 'reviewing';
  if (name.startsWith('production-orchestrator')) return 'thinking';
  if (name.startsWith('unreal-project-validation')) return 'building';
  if (name.startsWith('packaged-game-playtest')) return 'evaluating';
  return 'working';
}
function toolForCommand(command) {
  const value = path.basename(command).toLowerCase();
  if (value.includes('codex')) return 'AI / Codex';
  if (value.includes('unreal')) return 'Unreal Engine';
  if (value.includes('blender')) return 'Blender';
  if (value.includes('dotnet')) return '.NET';
  return path.basename(command);
}
function toolFromOutput(value) {
  const text = String(value);
  if (/\bblender(?:\.exe)?\b/i.test(text)) return 'Blender';
  if (/\bunreal(?:editor(?:-cmd)?(?:\.exe)?)?\b/i.test(text)) return 'Unreal Engine';
  if (/\bdotnet(?:\.exe)?\b/i.test(text)) return '.NET';
  return null;
}

export async function executeJob(job, ctx) {
  const { root, signal, uploadFile, reportProgress = () => {} } = ctx;
  const project = path.join(root, 'workspaces', job.workspaceId, 'project');
  const output = path.join(root, 'workspaces', job.workspaceId, 'runs', job.runId);
  await fsp.mkdir(project, { recursive: true }); await fsp.mkdir(output, { recursive: true });
  const logs = [], artifactIds = [];
  const playablePackages = [];
  const iterationReviews = [];
  const uploadedScreenshots = new Map();
  let currentProgress = { phase: 'preparing', goal: job.objective, status: 'running', steps: { completed: 0, total: 3 } };
  let publishing = Promise.resolve();
  const publish = patch => {
    const next = publishing.then(async () => {
      if (signal.aborted) return;
      const snapshot = await workspaceSnapshot(project, output);
      if (typeof uploadFile === 'function') {
        for (const screenshot of snapshot.screenshots.slice(0, 4)) {
          const key = `${screenshot.path}:${screenshot.updatedAt}`;
          let artifactId = uploadedScreenshots.get(key);
          if (!artifactId) {
            const root = screenshot.path.startsWith('project/') ? project : output;
            const relative = screenshot.path.replace(/^(?:project|run)\//, '');
            try {
              artifactId = await uploadFile(`worker-screenshot-${uploadedScreenshots.size}${path.extname(relative).toLowerCase()}`, path.join(root, relative), artifactContentType(relative));
              uploadedScreenshots.set(key, artifactId);
            } catch { /* A screenshot may still be locked or disappear while a tool writes it. */ }
          }
          if (artifactId) screenshot.artifactId = artifactId;
        }
      }
      currentProgress = { ...currentProgress, ...patch, updatedAt: new Date().toISOString(), ...snapshot };
      await reportProgress(currentProgress);
    });
    publishing = next.catch(() => {});
    return next;
  };
  let snapshotPending = false;
  const snapshotTimer = setInterval(() => {
    if (snapshotPending) return;
    snapshotPending = true;
    publish({}).catch(() => {}).finally(() => { snapshotPending = false; });
  }, 5000);
  snapshotTimer.unref?.();
  async function step(name, command, args, timeoutMs, cwd = project, accepts, options = {}) {
    signal.throwIfAborted();
    const monitorStep = name.startsWith('iteration-diagnosis');
    const codexStep = name.startsWith('production-orchestrator') || monitorStep;
    await publish({ phase: phaseForStep(name), step: name, tool: monitorStep ? 'Iteration monitor' : codexStep ? 'AI / Codex' : toolForCommand(command), command: path.basename(command), status: 'running', goal: job.objective,
      prompt: options.input || currentProgress.prompt, steps: { completed: currentProgress.steps?.completed || 0, total: 3 } });
    const stepFile = path.join(output, `${name}.json`);
    await atomicJson(stepFile, { name, status: 'RUNNING', startedAt: new Date().toISOString(), command, args });
    let pendingOutput = '';
    const onStdout = chunk => {
      if (!codexStep) return;
      pendingOutput += chunk;
      let newline;
      while ((newline = pendingOutput.indexOf('\n')) !== -1) {
        const line = pendingOutput.slice(0, newline); pendingOutput = pendingOutput.slice(newline + 1);
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.item?.type !== 'command_execution') continue;
        const done = event.type === 'item.completed';
        const tool = done ? 'AI / Codex' : toolFromOutput(event.item.command) || 'Shell';
        const phase = done ? 'thinking' : tool === 'Blender' ? 'crafting' : ['Unreal Engine', '.NET'].includes(tool) ? 'building' : 'working';
        publish({ tool, phase, command: done ? path.basename(command) : String(event.item.command || '').slice(0, 180) }).catch(() => {});
      }
      if (pendingOutput.length > 2 * 1024 * 1024) pendingOutput = '';
    };
    const result = await runCommand(command, args, { ...options, cwd, timeoutMs, signal,
      onStdout,
      stdoutFile: path.join(output, `${name}.stdout.jsonl`), stderrFile: path.join(output, `${name}.stderr.log`) });
    await atomicJson(stepFile, { name, ...result });
    if (!result.stopConfirmed) throw Object.assign(new Error(result.error), { stopConfirmed: false });
    signal.throwIfAborted();
    const passed = accepts ? await accepts(result) : !result.error && result.exitCode === 0 && !result.timedOut;
    logs.push({ name, ...result, passed });
    if (!passed) throw Object.assign(new Error(`${name} failed (exit ${result.exitCode}):\n${commandDiagnostic(result)}`), { result });
    if (!monitorStep) await publish({ status: 'running', steps: { completed: Math.min(3, (currentProgress.steps?.completed || 0) + 1), total: 3 } });
    return result;
  }
  const unreal = process.env.UNREAL_CMD || 'D:\\UE\\UE_5.8\\Engine\\Binaries\\Win64\\UnrealEditor-Cmd.exe';
  let failure;
  let production;
  try {
    production = await runProductionHarness({ job, project, output, signal, step, unreal, reportProgress: publish,
      onIterationReview: async ({ file, record }) => {
        const review = { iteration: record.iteration, action: record.action, category: record.category, reason: record.reason,
          aiInvoked: record.aiInvoked, file: path.basename(file) };
        iterationReviews.push(review);
        try {
          review.artifactId = await uploadFile(path.basename(file), file, 'application/json', { timeoutMs: 10000 });
          artifactIds.push(review.artifactId);
        } catch (error) {
          review.artifactUploadError = error.message;
          throw error;
        }
      },
      onIterationPackage: async ({ attempt, packageRoot }) => {
        if (typeof uploadFile !== 'function') return;
        const name = playablePackageName(attempt);
        const archiveFile = path.join(output, name);
        try {
          await archivePackage(packageRoot, archiveFile, signal);
          const artifactId = await uploadFile(name, archiveFile, artifactContentType(archiveFile));
          artifactIds.push(artifactId);
          playablePackages.push({ iteration: attempt, name, path: name, artifactId });
          await publish({ phase: 'publishing', status: 'running', goal: job.objective, iteration: attempt, step: `playable package iteration ${attempt}`, packageArtifact: name });
        } catch (error) {
          await publish({ phase: 'publishing', status: 'running', goal: job.objective, iteration: attempt, step: `playable package iteration ${attempt}`, packageArtifactError: error.message });
        }
      } });
    for (const file of Object.values(production.files)) artifactIds.push(await uploadFile(path.basename(file), file, artifactContentType(file)));
  } catch (error) {
    if (signal.aborted || error.stopConfirmed === false) throw error;
    failure = error.message;
    await publish({ phase: 'failed', status: 'failed', goal: job.objective, error: failure });
  } finally {
    clearInterval(snapshotTimer);
    await publishing;
  }
  await publish({ phase: failure ? 'failed' : 'completed', status: failure ? 'failed' : 'completed', goal: job.objective });
  const report = { protocol: 2, production: true, taskId: job.taskId, runId: job.runId, logs, passed: !failure, failure,
    deliverables: production ? Object.fromEntries(Object.entries(production.files).map(([role, file]) => [role, path.relative(project, file)])) : null,
    playablePackages, iterationReviews };
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
  await post('/v1/worker/register', { protocol: 2, capabilities: { platform: process.platform, node: process.version, productionHarness: 1, telemetry: 1, requiredOutputs: ['uproject', 'scene-preview', 'packaged-exe', 'acceptance-report'] } });
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
    let progress = { phase: 'preparing', status: 'running', goal: job.objective, steps: { completed: 0, total: 3 }, updatedAt: new Date().toISOString() };
    const reportProgress = value => { if (value && typeof value === 'object') progress = { ...value, updatedAt: value.updatedAt || new Date().toISOString() }; };
    const stopLease = maintainLease({ job, controller, intervalMs, heartbeat: () => post('/v1/worker/heartbeat', { ...identity(job), progress }) });
    await atomicJson(journal, { phase: 'RUNNING', bootId, job });
    let result;
    try {
      result = await execute(job, { root, signal: controller.signal, reportProgress, uploadFile: async (name, file, contentType, { timeoutMs = 60 * 60000 } = {}) => {
        controller.signal.throwIfAborted();
        const hash = crypto.createHash('sha256');
        for await (const chunk of fs.createReadStream(file, { signal: controller.signal })) hash.update(chunk);
        const sha = hash.digest('hex');
        const artifactId = `artifact-${crypto.createHash('sha256').update(`${job.jobId}:${name}:${sha}`).digest('hex')}`;
        const response = await fetch(`${control}/v1/worker/artifacts/${job.taskId}/${artifactId}`, { method: 'POST', duplex: 'half',
          headers: { ...headers, 'x-boot-id': bootId, 'x-job-id': job.jobId, 'x-lease-token': job.leaseToken, 'x-artifact-name': name, 'x-artifact-sha256': sha, 'content-type': contentType },
          body: fs.createReadStream(file), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]) });
        if (!response.ok) throw new Error(`Artifact upload failed (${response.status}).`);
        return (await response.json()).artifactId;
      } });
    } catch (error) {
      reportProgress({ phase: controller.signal.aborted ? 'canceled' : 'failed', status: controller.signal.aborted ? 'canceled' : 'failed', error: error.message });
      result = { status: controller.signal.aborted ? 'CANCELED' : 'FAIL', reason: error.message, artifactIds: [], stopConfirmed: error.stopConfirmed !== false };
    }
    result = { ...result, progress };
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
