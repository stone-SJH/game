import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { atomicJson, readJson, repositoryRoot } from '../agent/modeling-io.mjs';
import { modelingToolHashes } from '../agent/modeling-skill-routing.mjs';
import { modelingRuntimeIdentity } from '../agent/modeling-runtime-lock.mjs';
import { executionPolicy, verifyEvidence } from '../agent/modeling-execution.mjs';
import { codexInvocation } from '../agent/production-harness.mjs';
import { planBlockoutMigration, applyBlockoutMigration } from '../agent/blockout-task-migration.mjs';

const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--workspace', '--task', '--baseline-repo', '--out', '--apply'].includes(args[i]) || !args[i + 1]) throw new Error('Use --workspace PATH --task ID --baseline-repo PATH --out PLAN, or --apply PLAN.');
  options[args[i].slice(2)] = args[i + 1];
}
const revision = execFileSync('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
if (execFileSync('git', ['-C', repositoryRoot, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).trim()) throw new Error('Commit the target code before preparing or applying a migration.');
const harness = await modelingToolHashes();
if (options.apply) {
  const plan = await readJson(options.apply);
  if (plan.targetCommit !== revision) throw new Error('Migration requires its exact committed target release.');
  const workerRoot = path.dirname(path.dirname(plan.workspace));
  await fs.access(path.join(workerRoot, 'config/autostart.paused'));
  try { await fs.access(path.join(workerRoot, 'journal/execution.json')); throw new Error('Execution journal exists.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (process.platform !== 'win32') throw new Error('Live migration must be applied on the Windows worker.');
  const command = String.raw`@(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -match '(?i)[\\/]agent[\\/]agent\.mjs(?:"|\s|$)' } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress`;
  if (execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8', windowsHide: true }).trim()) throw new Error('Stop the idle worker before applying migration.');
  const audit = await applyBlockoutMigration(plan, `${options.apply}.audit.json`, harness);
  console.log(JSON.stringify({ status: audit.status, taskId: plan.taskId, targetCommit: revision, pins: audit.updatedPins.length, audit: `${options.apply}.audit.json` }));
} else {
  if (!options.workspace || !options.task || !options['baseline-repo'] || !options.out) throw new Error('Missing migration planning arguments.');
  const baseline = path.resolve(options['baseline-repo']);
  const { modelingToolHashes: beforeHashes } = await import(pathToFileURL(path.join(baseline, 'worker/agent/modeling-skill-routing.mjs')));
  const beforeHarness = await beforeHashes();
  await verifyEvidence(beforeHarness.map(row => ({ file: path.join(baseline, 'worker', row.file), sha256: row.sha256 })));
  const invocation = codexInvocation([]);
  const plan = await planBlockoutMigration({ workspace: path.resolve(options.workspace), taskId: options.task, beforeHarness, afterHarness: harness,
    runtime: await modelingRuntimeIdentity(invocation, path.join(options.workspace, 'project')), policy: executionPolicy(invocation), targetCommit: revision });
  await atomicJson(options.out, plan);
  console.log(JSON.stringify({ status: 'READY', taskId: plan.taskId, targetCommit: revision, pins: plan.updates.length, preservedFiles: plan.preserve.length, changed: plan.changed, plan: options.out }));
}
