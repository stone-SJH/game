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
import { codexInvocation, inspectProduction } from '../agent/production-harness.mjs';
import { modelingEnginePaths, validateUnrealModels } from '../agent/modeling-unreal.mjs';

const [workspaceArg, destinationArg, fromRepo, engineRepo = fromRepo] = process.argv.slice(2);
if (!workspaceArg || !destinationArg || !fromRepo) throw new Error('Usage: <original workspace> <new disposable workspace> <old release> [older engine release]');
const workspace = path.resolve(workspaceArg), destination = path.resolve(destinationArg);
if (destination === workspace || destination.startsWith(workspace + path.sep)) throw new Error('Probe destination must be outside the task.');
await fs.mkdir(destination, { recursive: false });
const originalProject = path.join(workspace, 'project'), project = path.join(destination, 'project');
const context = await readJson(path.join(originalProject, 'plan/production-context.json'));
const job = { taskId: context.taskId, workspaceId: context.workspaceId, objective: context.objective,
  runId: 'offline-toolchain-probe', referenceFiles: context.references || [] };
const originalTask = modelingTaskRoot(workspace, job), task = modelingTaskRoot(destination, job);
const originalExecution = await hashFile(path.join(originalTask, 'execution.json'));
const originalEngine = modelingEnginePaths(originalProject, job), engine = modelingEnginePaths(project, job);
const originalEngineLock = await readJson(originalEngine.lockFile);
const originalEngineHash = originalEngineLock ? await hashFile(path.join(originalEngine.executionRoot, 'execution.json')) : null;
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
  for (const round of Object.values(state.rounds || {})) {
    if (round.generatedBase) files.add(round.generatedBase.modelFile);
    if (round.concept?.image?.path) files.add(round.concept.image.path);
  }
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
const engineRouting = await import(pathToFileURL(path.join(engineRepo, 'worker/agent/modeling-skill-routing.mjs')));
const engineRuntime = await import(pathToFileURL(path.join(engineRepo, 'worker/agent/modeling-runtime-lock.mjs')));
const engineSource = { harnessHashes: await engineRouting.modelingToolHashes(),
  runtime: await engineRuntime.modelingRuntimeIdentity(invocation, project), revision: 'verified-engine-source' };
const unreal = process.env.UNREAL_CMD || 'D:\\UE\\UE_5.8\\Engine\\Binaries\\Win64\\UnrealEditor-Cmd.exe';
let projectFile;
if (originalEngineLock) {
  // Only the isolated fixture moves: real task identity and engine counters stay unchanged.
  const copiedOldEngine = path.join(destination, path.relative(workspace, originalEngine.executionRoot));
  await fs.rename(copiedOldEngine, engine.executionRoot);
  await fs.unlink(path.join(destination, path.relative(workspace, originalEngine.lockFile)));
  await atomicJson(engine.lockFile, { ...originalEngineLock, runtime: engineSource.runtime });
  const production = await inspectProduction(originalProject);
  assert.ok(production.files.projectFile, 'Retained Unreal project missing.');
  projectFile = path.join(project, path.relative(originalProject, production.files.projectFile));
  await fs.mkdir(path.dirname(projectFile), { recursive: true });
  await fs.copyFile(production.files.projectFile, projectFile);
  await fs.cp(path.join(path.dirname(production.files.projectFile), 'Content'), path.join(path.dirname(projectFile), 'Content'), { recursive: true });
}
const output = path.join(destination, 'probe-output'); await fs.mkdir(output);
let technicalCalls = 0;
const engineInput = { project, output, unreal, projectFile, invocation, job, iteration: 2, attempt: 1, allowProvisional: true,
  signal: new AbortController().signal, evaluate: async () => { throw new Error('Probe forbids a paid engine review'); },
  step: async (name, command, args) => {
    technicalCalls++;
    const directory = path.dirname(args.find(arg => arg.startsWith('-script=')).slice(8));
    const requestFile = path.join(directory, 'request.json'), request = await readJson(requestFile);
    // Exercise stage-GAP handoff without launching Unreal or claiming its quality passed.
    await atomicJson(path.join(directory, 'report.json'), { requestHash: await hashFile(requestFile), passed: false,
      assets: request.assets.map(row => ({ assetId: row.spec.assetId, requirementsHash: row.requirementsHash, passed: false, views: [] })) });
  } };
const retainedSummary = await readJson(path.join(project, 'plan/modeling-results.json'));
if (originalEngineLock) {
  await assert.rejects(validateUnrealModels({ ...engineInput, summary: retainedSummary }), { kind: 'TOOLCHAIN_CHANGED' });
  assert.equal(technicalCalls, 0);
}
const harnessHashes = await modelingToolHashes();
const upgrade = await upgradeModelingToolchain({ workspace: destination, job, fromHarnessHashes: await oldRouting.modelingToolHashes(),
  toHarnessHashes: harnessHashes, fromRuntime, toRuntime, policy, productionPolicy, sourceRevision: 'retained',
  targetRevision: 'offline-upgrade-probe', engineSource, unreal, apply: true });
await pinToolchain(path.join(task, 'execution-policy'), 'runtime', { policy, runtime: toRuntime, harnessHashes });
const ledger = await createProductionIterations({ project, job, policy: productionPolicy });
assert.equal(ledger.iteration, upgrade.iteration);
assert.equal(await ledger.reserveAttempt(), upgrade.consumedProductionAttempts + 1);
await ledger.best();
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
let engineResult = null;
if (originalEngineLock) {
  const before = await readJson(path.join(engine.executionRoot, 'execution.json'), null, 64 * 1024 * 1024);
  engineResult = await validateUnrealModels({ ...engineInput, iteration: ledger.iteration, summary: prepared || retainedSummary });
  assert.equal(engineResult.status, 'ENGINE_PROVISIONAL'); assert.equal(technicalCalls, 1);
  const after = await readJson(path.join(engine.executionRoot, 'execution.json'), null, 64 * 1024 * 1024);
  assert.equal(after.nextCall, before.nextCall + 1);
  for (const [key, group] of Object.entries(before.groups)) assert.deepEqual(after.groups[key], group);
  assert.equal(await hashFile(path.join(originalEngine.executionRoot, 'execution.json')), originalEngineHash);
}
assert.equal(await hashFile(path.join(originalTask, 'execution.json')), originalExecution);
const report = { passed: true, source: workspace, destination, iteration: upgrade.iteration, completedRounds: upgrade.completedRounds,
  consumedProductionAttempts: upgrade.consumedProductionAttempts, nextReservedAttempt: upgrade.consumedProductionAttempts + 1,
  verifiedArtifactCount: upgrade.verifiedArtifactCount, routes: upgrade.routes, nextStage, externalCalls: 0,
  originalExecutionUnchanged: true, copiedAssetFiles: files.size,
  engine: engineResult ? { status: engineResult.status, controlledTechnicalGap: true, technicalCalls,
    retainedCalls: upgrade.engine.consumedCalls, nextCallBefore: upgrade.engine.nextCall, originalExecutionUnchanged: true } : null };
await atomicJson(path.join(destination, 'probe-result.json'), report);
console.log(JSON.stringify(report));
