import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runCommand } from '../agent/process-runner.mjs';
import { localPath, hashFile, atomicJson, agentEnvironment } from '../agent/modeling-io.mjs';

// Batch imports and saved-map inspection do not need the full editor's Slate lifecycle.
// Keep rendering/PIE automation separate; there is deliberately no automatic editor fallback.
export async function runUnrealPython({ projectFile, script, output, unreal = process.env.UNREAL_CMD,
  plugins = [], rendering = false, timeoutMs = 600000, signal }, run = runCommand) {
  if (!projectFile || !/\.uproject$/i.test(projectFile) || !unreal) throw new Error('Provide --project and --unreal (or UNREAL_CMD).');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) throw new Error('Timeout must be 1..3600000 milliseconds.');
  if (!Array.isArray(plugins) || plugins.some(name => !/^[A-Za-z][A-Za-z0-9_]*$/.test(name))) throw new Error('Invalid plugin name.');
  projectFile = path.resolve(projectFile);
  const project = path.dirname(projectFile);
  await localPath(project, path.basename(projectFile), { existing: true });
  const scriptFile = await localPath(project, script, { existing: true });
  if (!/\.py$/i.test(scriptFile) || !(await fs.stat(scriptFile)).isFile()) throw new Error('Script must be a Python file inside the project.');
  const directory = await localPath(project, output);
  await fs.mkdir(path.dirname(directory), { recursive: true });
  await fs.mkdir(directory); // Each invocation retains its own logs; never overwrite a previous result.
  const log = path.join(directory, 'unreal.log');
  const args = [projectFile, '-unattended', '-nosplash', '-nop4', '-nosound',
    rendering ? '-AllowCommandletRendering' : '-NullRHI',
    '-run=pythonscript', `-script=${scriptFile}`, `-abslog=${log}`,
    ...(plugins.length ? [`-EnablePlugins=${plugins.join(',')}`] : [])];
  const request = { protocol: 1, mode: 'python-commandlet', projectFile, script, scriptHash: await hashFile(scriptFile),
    command: unreal, args, timeoutMs, createdAt: new Date().toISOString() };
  await atomicJson(path.join(directory, 'request.json'), request);
  const result = await run(unreal, args, { cwd: project, timeoutMs, signal, env: agentEnvironment(),
    stdoutFile: path.join(directory, 'stdout.log'), stderrFile: path.join(directory, 'stderr.log') });
  const engineLog = await fs.readFile(log, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const fatal = /Fatal error:|Object is not packaged:|=== Critical error:|LogPython: Error:|LogOutputDevice: Error:/.test(engineLog || '');
  const scriptUnchanged = await hashFile(scriptFile) === request.scriptHash;
  const passed = result.exitCode === 0 && !result.error && !result.timedOut && !result.canceled &&
    result.stopConfirmed === true && engineLog !== null && !fatal && scriptUnchanged;
  const report = { ...request, ...result, stdout: undefined, stderr: undefined,
    engineLog: path.relative(project, log).replaceAll('\\', '/'), engineLogPresent: engineLog !== null,
    scriptUnchanged, fatal, passed, scope: 'Command execution only; validate declared asset/map outputs separately.' };
  await atomicJson(path.join(directory, 'result.json'), report);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      project: { type: 'string' }, script: { type: 'string' }, output: { type: 'string' }, unreal: { type: 'string' },
      plugin: { type: 'string', multiple: true }, rendering: { type: 'boolean', default: false },
      'timeout-ms': { type: 'string', default: '600000' },
    } });
    const controller = new AbortController();
    for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => controller.abort());
    const result = await runUnrealPython({ projectFile: values.project, script: values.script, output: values.output,
      unreal: values.unreal, plugins: values.plugin, rendering: values.rendering,
      timeoutMs: Number(values['timeout-ms']), signal: controller.signal });
    console.log(JSON.stringify(result));
    if (!result.passed) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
