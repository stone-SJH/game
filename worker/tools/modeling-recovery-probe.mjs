// Read-only source workspace, disposable copy, zero author/reviewer/provider calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicJson, hashFile, readJson } from '../agent/modeling-io.mjs';
import { migrateModelingTask } from '../agent/modeling-migration.mjs';
import { modelingTaskRoot } from '../agent/modeling-recovery.mjs';
import { modelingRuntimeIdentity } from '../agent/modeling-runtime-lock.mjs';
import { modelingToolHashes } from '../agent/modeling-skill-routing.mjs';
import { executionPolicy } from '../agent/modeling-execution.mjs';
import { createModelingPipeline } from '../agent/modeling-pipeline.mjs';
import { createProductionIterations } from '../agent/production-iterations.mjs';
import { readModelingState } from '../agent/modeling-state.mjs';
import { codexInvocation } from '../agent/production-harness.mjs';

const [source, destination, fromRepo] = process.argv.slice(2);
if (!source || !destination || !fromRepo) throw new Error('Usage: <source workspace> <new disposable workspace> <old release repository>');
await fs.mkdir(destination, { recursive: false });
const sourceProject = path.join(source, 'project'), project = path.join(destination, 'project');
const context = await readJson(path.join(sourceProject, 'plan/production-context.json'));
const job = { taskId: context.taskId, workspaceId: context.workspaceId, runId: 'offline-recovery-probe',
  objective: context.objective + '\nContinue the same task after the verified recovery.' };
const originalTask = modelingTaskRoot(source, job), task = modelingTaskRoot(destination, job);
const sourceExecution = path.join(originalTask, 'execution.json'), originalExecutionHash = await hashFile(sourceExecution);
await fs.cp(path.join(source, 'modeling-state'), path.join(destination, 'modeling-state'), { recursive: true });
await fs.cp(path.join(source, 'production-state'), path.join(destination, 'production-state'), { recursive: true });
await fs.cp(path.join(sourceProject, 'plan'), path.join(project, 'plan'), { recursive: true });
await fs.cp(path.join(sourceProject, 'tools/modeling-skills'), path.join(project, 'tools/modeling-skills'), { recursive: true });
const files = new Set();
for (const entry of await fs.readdir(path.join(source, 'modeling-state'), { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^[a-f0-9]{20}$/.test(entry.name)) continue;
  const state = await readModelingState(path.join(source, 'modeling-state', entry.name, 'state.json'));
  for (const file of (state.accepted || state.bestCandidate)?.files || []) files.add(file.path);
  for (const file of state.spec.referenceImages) files.add(file);
}
for (const relative of files) {
  const target = path.join(project, relative); await fs.mkdir(path.dirname(target), { recursive: true });
  try { await fs.copyFile(path.join(sourceProject, relative), target, fs.constants.COPYFILE_EXCL); }
  catch (error) { if (error.code !== 'EEXIST') throw error; assert.equal(await hashFile(target), await hashFile(path.join(sourceProject, relative))); }
}
const invocation = codexInvocation([]), runtime = await modelingRuntimeIdentity(invocation, project);
// The disposable project has a different path in its trust fingerprint. Only
// this fixture lock is rebound; the real task's runtime must match exactly.
const runtimeFile = path.join(task, 'execution-policy/toolchain-runtime.json');
const oldLock = await readJson(runtimeFile);
await atomicJson(runtimeFile, { ...oldLock, runtime });
const old = await import(pathToFileURL(path.join(fromRepo, 'worker/agent/modeling-skill-routing.mjs')));
const migration = await migrateModelingTask({ workspace: destination, job, fromHarnessHashes: await old.modelingToolHashes(),
  toHarnessHashes: await modelingToolHashes(), runtime, policy: executionPolicy(invocation), sourceRevision: 'retained-release',
  targetRevision: 'offline-probe', apply: true });
const policy = (await readJson(path.join(destination, 'production-state', migration.productionIdentity, 'iterations.json'))).policy;
const ledger = await createProductionIterations({ project, job, policy });
assert.equal(await ledger.reserveAttempt(), migration.consumedProductionAttempts + 1);
const output = path.join(destination, 'probe-output'); await fs.mkdir(output);
const forbidden = async () => { throw new Error('Recovery attempted a new external operation.'); };
const options = { job, project, output, invocation, signal: new AbortController().signal,
  build: forbidden, step: forbidden, evaluate: forbidden, probe: forbidden,
  provider: { availability: forbidden, balance: forbidden, generate: forbidden } };
for (let resume = 0; resume < 2; resume++) {
  const pipeline = createModelingPipeline(options), result = await pipeline.prepare({ iteration: ledger.iteration });
  await pipeline.verify();
  assert.equal(result.assets.length, migration.assets.length);
  for (const entry of migration.assets) {
    const asset = result.assets.find(row => row.assetId === entry.assetId);
    assert.equal(asset.quality.score, entry.score); assert.equal(Boolean(asset.usable), entry.usable);
  }
}
assert.equal(await hashFile(path.join(task, 'execution.json')), originalExecutionHash);
assert.equal(await hashFile(sourceExecution), originalExecutionHash);
for (const relative of files) assert.equal(await hashFile(path.join(project, relative)), await hashFile(path.join(sourceProject, relative)));
const report = { passed: true, source, destination, copiedFiles: files.size, assets: migration.assets.map(({ assetId, usable, score }) => ({ assetId, usable, score })),
  stateCount: migration.stateCount, consumedProductionAttempts: migration.consumedProductionAttempts,
  sourceExecutionUnchanged: true, authorCalls: 0, reviewerCalls: 0, providerCalls: 0, resumes: 2 };
await atomicJson(path.join(destination, 'probe-result.json'), report);
console.log(JSON.stringify(report, null, 2));
