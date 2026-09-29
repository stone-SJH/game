import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { migrateModelingTask } from '../agent/modeling-migration.mjs';
import { modelingToolHashes } from '../agent/modeling-skill-routing.mjs';
import { modelingRuntimeIdentity } from '../agent/modeling-runtime-lock.mjs';
import { executionPolicy } from '../agent/modeling-execution.mjs';
import { codexInvocation } from '../agent/production-harness.mjs';
import { repositoryRoot } from '../agent/modeling-io.mjs';

export async function main(args) {
  const options = {}, switches = new Set(['--apply']);
  for (let i = 0; i < args.length; i++) {
    if (switches.has(args[i])) options[args[i].slice(2)] = true;
    else if (['--workspace', '--task-id', '--workspace-id', '--from-repo', '--worker-root'].includes(args[i]) && args[i + 1]) options[args[i++].slice(2)] = args[i];
    else throw new Error('Unknown recovery argument: ' + args[i]);
  }
  for (const key of ['workspace', 'task-id', 'workspace-id', 'from-repo', 'worker-root']) if (!options[key]) throw new Error('Missing --' + key);
  const git = (repo, ...argv) => execFileSync('git', ['-C', repo, ...argv], { encoding: 'utf8' }).trim();
  const sourceRevision = git(options['from-repo'], 'rev-parse', 'HEAD'), targetRevision = git(repositoryRoot, 'rev-parse', 'HEAD');
  if (git(options['from-repo'], 'status', '--porcelain', '--', 'worker', 'skills')) throw new Error('Old release has local changes.');
  if (options.apply) {
    if (git(repositoryRoot, 'status', '--porcelain')) throw new Error('Commit the tested target release before migration.');
    await fs.access(path.join(options['worker-root'], 'config/autostart.paused'));
    try { await fs.access(path.join(options['worker-root'], 'journal/execution.json')); throw new Error('Worker execution journal exists.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (process.platform !== 'win32') throw new Error('Apply requires the Windows worker offline check.');
    const running = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '@(Get-CimInstance Win32_Process -Filter "Name = \'node.exe\'" | Where-Object { $_.CommandLine -match \'(?i)[\\\\/]agent[\\\\/]agent[.]mjs\' }).Count'], { encoding: 'utf8' }).trim();
    if (running !== '0') throw new Error('Stop the idle worker under maintenance before migration.');
  }
  const old = await import(pathToFileURL(path.join(options['from-repo'], 'worker/agent/modeling-skill-routing.mjs')));
  const invocation = codexInvocation([]);
  const result = await migrateModelingTask({ workspace: path.resolve(options.workspace), job: { taskId: options['task-id'], workspaceId: options['workspace-id'] },
    fromHarnessHashes: await old.modelingToolHashes(), toHarnessHashes: await modelingToolHashes(),
    runtime: await modelingRuntimeIdentity(invocation, path.join(options.workspace, 'project')), policy: executionPolicy(invocation),
    sourceRevision, targetRevision, apply: Boolean(options.apply) });
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
