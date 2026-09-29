// Exercise the real paused task on a disposable copy; never invoke paid tools.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicJson, readJson, hashFile, localPath } from '../agent/modeling-io.mjs';
import { upgradeModelingToolchain } from '../agent/modeling-toolchain-upgrade.mjs';
import { readModelingState } from '../agent/modeling-state.mjs';
import { modelingTaskRoot } from '../agent/modeling-recovery.mjs';
import { modelingToolHashes, pinToolchain } from '../agent/modeling-skill-routing.mjs';
import { modelingRuntimeIdentity } from '../agent/modeling-runtime-lock.mjs';
import { executionPolicy } from '../agent/modeling-execution.mjs';
import { qualityReviewSettings } from '../agent/quality-review.mjs';
import { createProductionIterations } from '../agent/production-iterations.mjs';
import { createModelingPipeline } from '../agent/modeling-pipeline.mjs';
import { codexInvocation } from '../agent/production-harness.mjs';

const [workspace, destination, fromRepo] = process.argv.slice(2);
if (!workspace || !destination || !fromRepo) throw new Error('Usage: <original workspace> <new disposable workspace> <old release>');
await fs.mkdir(destination, { recursive: false });
const originalProject = path.join(workspace, 'project'), project = path.join(destination, 'project');
const context = await readJson(path.join(originalProject, 'plan/production-context.json'));
const job = { taskId: context.taskId, workspaceId: context.workspaceId, objective: context.objective,
  runId: 'offline-toolchain-probe', referenceFiles: context.references || [] };
const originalTask = modelingTaskRoot(workspace, job), task = modelingTaskRoot(destination, job);
const originalExecution = await hashFile(path.join(originalTask, 'execution.json'));
for (const name of ['modeling-state', 'production-state']) await fs.cp(path.join(workspace, name), path.join(destination, name), { recursive: true });
for (const name of ['plan', 'tools/modeling-skills']) await fs.cp(path.join(originalProject, name), path.join(project, name), { recursive: true });
const files = new Set();
for (const entry of await fs.readdir(path.join(workspace, 'modeling-state'))) {
  if (!/^[a-f0-9]{20}$/.test(entry)) continue;
  const state = await readModelingState(path.join(workspace, 'modeling-state', entry, 'state.json'));
  for (const candidate of [state.accepted, state.bestCandidate, ...Object.values(state.rounds || {}).map(row => row.stageGap)].filter(Boolean)) {
    for (const row of candidate.files || []) files.add(row.path);
  }
  for (const ref of state.spec.referenceImages) files.add(ref);
}
for (const file of files) {
  const source = await localPath(originalProject, file, { existing: true }), target = await localPath(project, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  try { await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL); }
  catch (error) { if (error.code !== 'EEXIST') throw error; assert.equal(await hashFile(target), await hashFile(source)); }
}
const oldRouting = await import(pathToFileURL(path.join(fromRepo, 'worker/agent/modeling-skill-routing.mjs')));
const oldRuntime = await import(pathToFileURL(path.join(fromRepo, 'worker/agent/modeling-runtime-lock.mjs')));
const invocation = codexInvocation([]), policy = executionPolicy(invocation), productionPolicy = qualityReviewSettings();
const fromRuntime = await oldRuntime.modelingRuntimeIdentity(invocation, project), toRuntime = await modelingRuntimeIdentity(invocation, project);
const runtimeFile = path.join(task, 'execution-policy/toolchain-runtime.json'), lock = await readJson(runtimeFile);
// Rebind only the disposable copy's project trust fingerprint.
await atomicJson(runtimeFile, { ...lock, runtime: fromRuntime });
const harnessHashes = await modelingToolHashes();
const upgrade = await upgradeModelingToolchain({ workspace: destination, job, fromHarnessHashes: await oldRouting.modelingToolHashes(),
  toHarnessHashes: harnessHashes, fromRuntime, toRuntime, policy, productionPolicy, sourceRevision: 'retained',
  targetRevision: 'offline-upgrade-probe', apply: true });
await pinToolchain(path.join(task, 'execution-policy'), 'runtime', { policy, runtime: toRuntime, harnessHashes });
const ledger = await createProductionIterations({ project, job, policy: productionPolicy });
assert.equal(ledger.iteration, upgrade.iteration);
assert.equal(await ledger.reserveAttempt(), upgrade.consumedProductionAttempts + 1);
await ledger.best();
const output = path.join(destination, 'probe-output'); await fs.mkdir(output);
const calls = [];
const stop = name => { calls.push(name); throw Object.assign(new Error('OFFLINE_PROBE_NEXT_STAGE'), { executionFence: true }); };
const pipeline = createModelingPipeline({ job, project, output, invocation, signal: new AbortController().signal,
  step: async name => stop('step:' + name), evaluate: async ({ name }) => stop('review:' + name),
  build: async context => stop('build:' + context.decision.route), probe: async () => stop('capability'),
  provider: { availability: async () => ({ enabled: true }), balance: async () => ({ status: 'ready', balance: 1 }), generate: async () => stop('tripo') },
  imageProvider: { generate: async () => stop('gpt-image-2') } });
let nextStage = null, prepared = null;
try { prepared = await pipeline.prepare({ iteration: ledger.iteration }); await pipeline.verify(); }
catch (error) { if (error.message !== 'OFFLINE_PROBE_NEXT_STAGE') throw error; nextStage = calls.at(-1); }
assert.ok(nextStage || prepared?.assets.length, 'No retained output or resumable stage found.');
assert.equal(await hashFile(path.join(originalTask, 'execution.json')), originalExecution);
const report = { passed: true, source: workspace, destination, iteration: upgrade.iteration, completedRounds: upgrade.completedRounds,
  consumedProductionAttempts: upgrade.consumedProductionAttempts, nextReservedAttempt: upgrade.consumedProductionAttempts + 1,
  verifiedArtifactCount: upgrade.verifiedArtifactCount, routes: upgrade.routes, nextStage, externalCalls: 0,
  originalExecutionUnchanged: true, copiedAssetFiles: files.size };
await atomicJson(path.join(destination, 'probe-result.json'), report);
console.log(JSON.stringify(report));
