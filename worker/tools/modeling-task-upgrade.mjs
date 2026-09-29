import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { upgradeModelingToolchain } from '../agent/modeling-toolchain-upgrade.mjs';
import { modelingToolHashes } from '../agent/modeling-skill-routing.mjs';
import { modelingRuntimeIdentity } from '../agent/modeling-runtime-lock.mjs';
import { executionPolicy } from '../agent/modeling-execution.mjs';
import { qualityReviewSettings } from '../agent/quality-review.mjs';
import { codexInvocation } from '../agent/production-harness.mjs';
import { atomicJson, repositoryRoot } from '../agent/modeling-io.mjs';

export async function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') options.apply = true;
    else if (['--workspace', '--task-id', '--workspace-id', '--from-repo', '--engine-from-repo', '--worker-root', '--report'].includes(args[i]) && args[i + 1]) options[args[i++].slice(2)] = args[i];
    else throw new Error('Unknown upgrade argument: ' + args[i]);
  }
  for (const key of ['workspace', 'task-id', 'workspace-id', 'from-repo', 'worker-root', 'report']) if (!options[key]) throw new Error('Missing --' + key);
  const git = (repo, ...argv) => execFileSync('git', ['-C', repo, ...argv], { encoding: 'utf8', windowsHide: true }).trim();
  const sourceRevision = git(options['from-repo'], 'rev-parse', 'HEAD'), targetRevision = git(repositoryRoot, 'rev-parse', 'HEAD');
  if (git(options['from-repo'], 'status', '--porcelain', '--', 'worker', 'skills')) throw new Error('Old release has local changes.');
  if (options.apply) {
    if (git(repositoryRoot, 'status', '--porcelain')) throw new Error('Commit the tested target release before migration.');
    await fs.access(path.join(options['worker-root'], 'config/autostart.paused'));
    try { await fs.access(path.join(options['worker-root'], 'journal/execution.json')); throw new Error('Worker execution journal exists.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (process.platform !== 'win32') throw new Error('Apply requires the Windows worker offline check.');
    const running = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '@(Get-CimInstance Win32_Process -Filter "Name = \'node.exe\'" | Where-Object { $_.CommandLine -match \'(?i)[\\\\/]agent[\\\\/]agent[.]mjs\' }).Count'],
    { encoding: 'utf8', windowsHide: true }).trim();
    if (running !== '0') throw new Error('Stop the idle worker under maintenance before migration.');
  }
  const oldRouting = await import(pathToFileURL(path.join(options['from-repo'], 'worker/agent/modeling-skill-routing.mjs')));
  const oldRuntime = await import(pathToFileURL(path.join(options['from-repo'], 'worker/agent/modeling-runtime-lock.mjs')));
  const invocation = codexInvocation([]), workspace = path.resolve(options.workspace), project = path.join(workspace, 'project');
  let engineSource;
  if (options['engine-from-repo']) {
    const repo = options['engine-from-repo'];
    if (git(repo, 'status', '--porcelain', '--', 'worker', 'skills')) throw new Error('Engine source release has local changes.');
    const routing = await import(pathToFileURL(path.join(repo, 'worker/agent/modeling-skill-routing.mjs')));
    const runtime = await import(pathToFileURL(path.join(repo, 'worker/agent/modeling-runtime-lock.mjs')));
    engineSource = { harnessHashes: await routing.modelingToolHashes(), runtime: await runtime.modelingRuntimeIdentity(invocation, project), revision: git(repo, 'rev-parse', 'HEAD') };
  }
  const result = await upgradeModelingToolchain({ workspace, job: { taskId: options['task-id'], workspaceId: options['workspace-id'] },
    fromHarnessHashes: await oldRouting.modelingToolHashes(), toHarnessHashes: await modelingToolHashes(),
    fromRuntime: await oldRuntime.modelingRuntimeIdentity(invocation, project), toRuntime: await modelingRuntimeIdentity(invocation, project),
    policy: executionPolicy(invocation), productionPolicy: qualityReviewSettings(), sourceRevision, targetRevision, engineSource,
    unreal: process.env.UNREAL_CMD || 'D:\\UE\\UE_5.8\\Engine\\Binaries\\Win64\\UnrealEditor-Cmd.exe', apply: Boolean(options.apply) });
  await atomicJson(options.report, result);
  console.log(JSON.stringify({ phase: result.phase, sourceRevision, targetRevision, iteration: result.iteration,
    completedRounds: result.completedRounds, consumedProductionAttempts: result.consumedProductionAttempts,
    stateCount: result.stateCount, verifiedArtifactCount: result.verifiedArtifactCount, routes: result.routes,
    engine: result.engine, backupRoot: result.backupRoot, report: options.report }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
