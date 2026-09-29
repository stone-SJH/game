import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicJson, readJson, hashFile, hashValue, repositoryRoot } from '../agent/modeling-io.mjs';
import { upgradeModelingToolchain } from '../agent/modeling-toolchain-upgrade.mjs';
import { modelingTaskRoot, recoveredModelingReferences } from '../agent/modeling-recovery.mjs';
import { readModelingState } from '../agent/modeling-state.mjs';
import { defaultContract } from '../agent/modeling-contract.mjs';
import { createSkillPlan, modelingToolHashes } from '../agent/modeling-skill-routing.mjs';
import { createProductionIterations } from '../agent/production-iterations.mjs';
import { createModelingPipeline } from '../agent/modeling-pipeline.mjs';
import { modelingRuntimeIdentity } from '../agent/modeling-runtime-lock.mjs';
import { executionPolicy } from '../agent/modeling-execution.mjs';
import { prefersImageModeling } from '../agent/modeling-evaluation.mjs';
import { RUBRIC_VERSION } from '../agent/modeling-rubric.mjs';
import { prepareModelingReferences } from '../agent/modeling-research.mjs';
import { modelingEnginePaths, validateUnrealModels } from '../agent/modeling-unreal.mjs';

async function fixture(t, started = false) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'toolchain-upgrade-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const project = path.join(workspace, 'project'), output = path.join(workspace, 'run');
  await fs.mkdir(project); await fs.mkdir(output);
  const job = { taskId: 'task', workspaceId: 'workspace', runId: 'continue', objective: 'Keep the existing game' };
  const invocation = { command: process.execPath, args: [] }, policy = executionPolicy(invocation);
  const toRuntime = await modelingRuntimeIdentity(invocation, project), fromRuntime = { ...toRuntime };
  toRuntime.imageGeneration = { ...toRuntime.imageGeneration, model: 'gpt-image-2',
    endpointHash: toRuntime.imageGeneration.endpointHash || '1'.repeat(64) };
  delete fromRuntime.imageGeneration;
  const spec = { assetId: 'monk', description: '静态坐姿人物', prompt: '面部、手指和层叠衣褶清晰可见',
    requirements: ['面部和手指可供近景阅读'], referenceImages: [], maxTriangles: 30000, requireRig: false,
    requireClosedMesh: false, contract: defaultContract({ assetClass: 'organic-static' }) };
  const skill = await createSkillPlan({ spec, project });
  const validators = await Promise.all(['modeling-asset-check.py', 'modeling_scene.py', 'modeling_quality.py',
    'modeling_reference.py', 'modeling-unreal-check.py'].map(name => hashFile(path.join(repositoryRoot, 'worker/tools', name))));
  const fromHarnessHashes = [{ file: 'agent/modeling-pipeline.mjs', sha256: '0'.repeat(64) }], toHarnessHashes = await modelingToolHashes();
  const requirementsHash = hashValue({ taskId: job.taskId, workspaceId: job.workspaceId, spec, referenceHashes: [],
    skillLockHash: skill.lockHash, validatorHashes: validators, blenderVersion: 'test' });
  const stateFile = path.join(workspace, 'modeling-state', requirementsHash.slice(0, 20), 'state.json');
  const state = { protocol: 2, spec, requirementsHash, route: 'blender_direct', originalRoute: 'blender_direct',
    decision: { route: 'blender_direct' }, attempts: { blender_direct: started ? 4 : 3 }, failures: [],
    productionIteration: started ? 2 : 1, rounds: { 1: { attempts: { blender_direct: 3 } },
      ...(started ? { 2: { attempts: { blender_direct: 1 } } } : {}) }, pending: null };
  await atomicJson(stateFile, state);
  const task = modelingTaskRoot(workspace, job), plan = { reason: 'Original', assets: [spec] };
  await atomicJson(path.join(task, 'plan.json'), plan);
  await atomicJson(path.join(task, 'execution-policy/toolchain-runtime.json'), { policy, runtime: fromRuntime, harnessHashes: fromHarnessHashes });
  await atomicJson(path.join(task, 'toolchain-monk.json'), { version: 3, skillLockHash: skill.lockHash, validatorHashes: validators,
    blenderVersion: 'test', policy, harnessHashes: fromHarnessHashes, rubricVersion: RUBRIC_VERSION });
  const executionFile = path.join(task, 'execution.json');
  await atomicJson(executionFile, { protocol: 3, nextCall: 9, groups: {
    original: { key: 'original', deadlineAt: 100, calls: [{ callId: 'author-8', status: 'FAILED', error: { stopConfirmed: true } }] } } });
  await fs.mkdir(path.join(workspace, 'rounds'));
  const artifact = path.join(workspace, 'rounds', 'original.blend');
  await fs.writeFile(artifact, 'preserved delivered model');
  const evidence = [{ file: artifact, sha256: await hashFile(artifact) }];
  const engine = modelingEnginePaths(project, job), unreal = process.execPath;
  await atomicJson(engine.lockFile, { policy, runtime: fromRuntime, harnessHashes: fromHarnessHashes, unrealHash: await hashFile(unreal) });
  const engineExecutionFile = path.join(engine.executionRoot, 'execution.json');
  await atomicJson(engineExecutionFile, { protocol: 3, nextCall: 4, groups: {
    retained: { key: 'original-engine', completed: true, deadlineAt: 123,
      calls: [{ callId: 'technical-3', status: 'COMPLETED', stopConfirmed: true }], result: { evidence } } } });
  const identity = hashValue('retained-production'), productionPolicy = { maxIterations: 10, timeoutMs: 1200000, scoreThreshold: 85 };
  const productionFile = path.join(workspace, 'production-state', identity, 'iterations.json');
  await atomicJson(productionFile, { protocol: 1, policy: productionPolicy, iteration: 2, attempts: 11,
    rounds: [{ iteration: 1, score: 46, evidence }], best: { files: { projectFile: artifact }, evidence,
      qualityAccepted: false, delivery: { iteration: 1, score: 46 } } });
  await atomicJson(path.join(task, 'recovery.json'), { protocol: 1, taskId: job.taskId, workspaceId: job.workspaceId,
    id: 'previous-recovery', iteration: 1, productionIdentity: identity, planHash: hashValue(plan), assets: [{
      assetId: spec.assetId, baseHash: hashValue(spec), statePath: path.relative(workspace, stateFile).replaceAll('\\', '/'),
      specHash: hashValue(spec), requirementsHash, referenceEvidence: [], usable: false, score: 0 }] });
  return { workspace, project, task, output, job, invocation, stateFile, state, productionFile, executionFile, artifact, spec, engine, engineExecutionFile, unreal,
    options: { workspace, job, fromHarnessHashes, toHarnessHashes, fromRuntime, toRuntime, policy, productionPolicy,
      sourceRevision: 'verified-old', targetRevision: 'verified-image', unreal } };
}

test('offline image upgrade preserves finished rounds, stage deadlines, counters and original files', async t => {
  const f = await fixture(t), before = await hashFile(f.executionFile), productionHash = await hashFile(f.productionFile);
  const preview = await upgradeModelingToolchain(f.options);
  assert.equal(preview.iteration, 2); assert.equal(preview.completedRounds, 1); assert.equal(preview.consumedProductionAttempts, 11);
  assert.deepEqual(preview.routes.map(row => row.earliestIteration), [2]);
  assert.equal((await readModelingState(f.stateFile)).imageRouteUpgrade, undefined);
  const result = await upgradeModelingToolchain({ ...f.options, apply: true });
  assert.equal(result.phase, 'COMMITTED'); assert.equal(await hashFile(f.executionFile), before);
  assert.equal(result.engine.nextCall, 4); assert.equal(result.engine.consumedCalls, 1);
  assert.equal(await hashFile(f.engineExecutionFile), result.engine.executionHash);
  assert.deepEqual((await readJson(f.engine.lockFile)).harnessHashes, f.options.toHarnessHashes);
  assert.equal(await hashFile(f.productionFile), productionHash);
  const after = await readModelingState(f.stateFile), { imageRouteUpgrade, ...unchanged } = after;
  assert.deepEqual(unchanged, f.state); assert.equal(imageRouteUpgrade.earliestIteration, 2);
  for (const row of result.originals) assert.equal(await hashFile(path.join(result.backupRoot, row.path)), row.sha256);
  const ledger = await createProductionIterations({ project: f.project, job: { ...f.job, objective: 'Continue after deployment' }, policy: f.options.productionPolicy });
  assert.equal(ledger.iteration, 2); assert.equal((await ledger.best()).delivery.score, 46);
  assert.equal(await ledger.reserveAttempt(), 12);
  await assert.rejects(upgradeModelingToolchain({ ...f.options, apply: true }), /source release hashes differ/);
});

test('a started modeling round gets the new route only in the following whole iteration', async t => {
  const f = await fixture(t, true), result = await upgradeModelingToolchain(f.options);
  assert.equal(result.routes[0].earliestIteration, 3);
  assert.deepEqual((await readModelingState(f.stateFile)).rounds[2].attempts, { blender_direct: 1 });
});

test('recovered references remain frozen and the next untouched round reaches image generation with old counters', async t => {
  const f = await fixture(t);
  await upgradeModelingToolchain({ ...f.options, apply: true });
  const recovery = await recoveredModelingReferences({ project: f.project, job: f.job,
    plan: await readJson(path.join(f.task, 'plan.json')), iteration: 2 });
  assert.deepEqual(recovery.frozenAssetIds, ['monk']);
  const assets = [{ ...f.spec, prompt: 'Faithful replica of the original character' }];
  let researchCalls = 0;
  const research = await prepareModelingReferences({ assets, project: f.project, job: f.job, iteration: 2,
    frozenAssetIds: recovery.frozenAssetIds, signal: new AbortController().signal, reportProgress: async () => {},
    review: async () => { researchCalls++; return { references: [], blocked: [{ assetId: 'monk', reason: 'No source' }] }; } });
  assert.deepEqual(research.assets, assets); assert.equal(researchCalls, 0);
  // A genuine revision can research again; recovery must not globally disable it.
  await prepareModelingReferences({ assets, project: f.project, job: f.job, iteration: 2,
    signal: new AbortController().signal, reportProgress: async () => {},
    review: async () => { researchCalls++; return { references: [], blocked: [{ assetId: 'monk', reason: 'No source' }] }; } });
  assert.equal(researchCalls, 1);
  await atomicJson(path.join(f.task, 'capabilities-2.json'), { blenderMcpAvailable: true, blenderVersion: 'test' });
  // Match the test runner's actual runtime; the upgrade fixture may supply dummy image settings.
  await atomicJson(path.join(f.task, 'execution-policy/toolchain-runtime.json'), {
    policy: f.options.policy, runtime: await modelingRuntimeIdentity(f.invocation, f.project), harnessHashes: f.options.toHarnessHashes });
  const forbidden = async () => { throw new Error('Unexpected author, research or provider operation'); };
  let images = 0;
  const pipeline = createModelingPipeline({ ...f, signal: new AbortController().signal,
    step: forbidden, evaluate: forbidden, build: forbidden, probe: forbidden,
    provider: { availability: async () => ({ enabled: true }), balance: async () => ({ status: 'ready' }), generate: forbidden },
    imageProvider: { generate: async () => { images++; throw Object.assign(new Error('IMAGE_STAGE_REACHED'), { executionFence: true }); } } });
  await assert.rejects(pipeline.prepare({ iteration: 2 }), /IMAGE_STAGE_REACHED/);
  const state = await readModelingState(f.stateFile);
  assert.equal(images, 1); assert.equal(state.route, 'image_tripo_blender');
  assert.equal(state.imageRouteUpgrade.appliedIteration, 2);
  assert.deepEqual(state.attempts, f.state.attempts);
  assert.deepEqual(state.rounds[1], f.state.rounds[1]);
});

test('upgrade rejects model/policy changes, unsettled calls and mutated retained results before writing', async t => {
  const f = await fixture(t);
  await assert.rejects(upgradeModelingToolchain({ ...f.options, apply: true, toRuntime: { ...f.options.toRuntime, configuredModel: 'different' } }), /model\/CLI/);
  await assert.rejects(upgradeModelingToolchain({ ...f.options, policy: { ...f.options.policy, buildMs: 1 } }), /policy or budget/);
  const execution = await readJson(f.executionFile);
  execution.groups.original.calls[0].status = 'STARTED'; await atomicJson(f.executionFile, execution);
  await assert.rejects(upgradeModelingToolchain(f.options), { kind: 'STOP_UNCONFIRMED' });
  execution.groups.original.calls[0].status = 'FAILED'; await atomicJson(f.executionFile, execution);
  await fs.appendFile(f.artifact, 'corruption');
  await assert.rejects(upgradeModelingToolchain({ ...f.options, apply: true }), /evidence changed/);
  await assert.rejects(fs.stat(path.join(f.workspace, 'recovery')), { code: 'ENOENT' });
});

test('static characters with face, finger and cloth detail qualify without magic quality words', () => {
  assert.equal(prefersImageModeling({ description: '坐姿人物', prompt: '手指与衣褶', requirements: [], contract: { assetClass: 'organic-static' } }), true);
  assert.equal(prefersImageModeling({ description: 'Mechanical cabinet', prompt: 'Cabinet', requirements: [], contract: { assetClass: 'modular-kit' } }), false);
});

test('an older engine pin is repaired alongside current task pins without replaying consumed calls', async t => {
  const f = await fixture(t);
  const engineSource = { harnessHashes: f.options.fromHarnessHashes, runtime: f.options.fromRuntime, revision: 'older-engine-release' };
  const taskHarness = [{ file: 'agent/modeling-pipeline.mjs', sha256: '2'.repeat(64) }];
  for (const file of [path.join(f.task, 'execution-policy/toolchain-runtime.json'), path.join(f.task, 'toolchain-monk.json')]) {
    const lock = await readJson(file);
    await atomicJson(file, { ...lock, harnessHashes: taskHarness, ...(lock.runtime ? { runtime: f.options.toRuntime } : {}) });
  }
  const options = { ...f.options, fromHarnessHashes: taskHarness, fromRuntime: f.options.toRuntime, engineSource };
  await assert.rejects(upgradeModelingToolchain({ ...options, engineSource: undefined }), /engine source release/);
  const stateHash = await hashFile(f.stateFile), engineHash = await hashFile(f.engineExecutionFile);
  const upgraded = await upgradeModelingToolchain({ ...options, apply: true });
  assert.equal(upgraded.engine.sourceRevision, 'older-engine-release');
  assert.equal(await hashFile(f.stateFile), stateHash);
  assert.equal(await hashFile(f.engineExecutionFile), engineHash);
  assert.equal(upgraded.routes.length, 0);
});

test('engine uncertainty, executable drift and missing pins fail before any migration writes', async t => {
  const f = await fixture(t), ledger = await readJson(f.engineExecutionFile);
  ledger.groups.retained.calls[0].status = 'STARTED'; await atomicJson(f.engineExecutionFile, ledger);
  await assert.rejects(upgradeModelingToolchain({ ...f.options, apply: true }), { kind: 'STOP_UNCONFIRMED' });
  ledger.groups.retained.calls[0].status = 'FAILED';
  ledger.groups.retained.calls[0].error = { stopConfirmed: false }; await atomicJson(f.engineExecutionFile, ledger);
  await assert.rejects(upgradeModelingToolchain(f.options), { kind: 'STOP_UNCONFIRMED' });
  delete ledger.groups.retained.calls[0].error; await atomicJson(f.engineExecutionFile, ledger);
  const lock = await readJson(f.engine.lockFile);
  await atomicJson(f.engine.lockFile, { ...lock, unrealHash: '0'.repeat(64) });
  await assert.rejects(upgradeModelingToolchain(f.options), /Unreal executable/);
  await fs.unlink(f.engine.lockFile);
  await assert.rejects(upgradeModelingToolchain(f.options), /without its toolchain lock/);
  await assert.rejects(fs.stat(path.join(f.workspace, 'recovery')), { code: 'ENOENT' });
});

test('real Unreal validator continues after migration and hands off a technical GAP with original engine history', async t => {
  const f = await fixture(t), original = await readJson(f.engineExecutionFile);
  const engineSpec = structuredClone(f.spec); engineSpec.contract.runtime.engine = 'unreal';
  const model = 'art/' + (f.spec.contract.runtime.profile === 'glb-static' ? 'model.glb' : 'model.fbx');
  await fs.mkdir(path.join(f.project, 'art'));
  await fs.writeFile(path.join(f.project, model), 'fixture export');
  const geometry = 'art/geometry-report.json';
  await atomicJson(path.join(f.project, geometry), { export: { dimensions: [1, 1, 1] }, source: { gates: [] } });
  const files = await Promise.all([model, geometry].map(async name => ({ path: name, sha256: await hashFile(path.join(f.project, name)) })));
  const summary = { assets: [{ assetId: f.spec.assetId, spec: engineSpec, contract: engineSpec.contract, requirementsHash: 'retained-asset', files, usable: true }] };
  await atomicJson(path.join(f.project, 'plan/modeling-engine-imports.json'), { protocol: 2, assets: [{
    assetId: f.spec.assetId, packagePath: '/Game/Models/Monk.Monk', mapPath: '/Game/Maps/Validation' }] });
  const projectFile = path.join(f.project, 'Fixture.uproject'); await fs.writeFile(projectFile, '{}');
  await fs.mkdir(path.join(f.project, 'Content')); await fs.writeFile(path.join(f.project, 'Content/mesh.uasset'), 'fixture content');
  let technicalCalls = 0;
  const input = { ...f, summary, projectFile, signal: new AbortController().signal, iteration: 2, attempt: 12, allowProvisional: true,
    step: async (name, command, args) => {
      technicalCalls++;
      assert.equal(name, 'modeling-unreal-12-technical-4');
      const directory = path.dirname(args.find(arg => arg.startsWith('-script=')).slice(8));
      const requestFile = path.join(directory, 'request.json'), request = await readJson(requestFile);
      await atomicJson(path.join(directory, 'report.json'), { requestHash: await hashFile(requestFile), passed: false,
        assets: request.assets.map(row => ({ assetId: row.spec.assetId, requirementsHash: row.requirementsHash, passed: false, views: [] })) });
    } };
  await assert.rejects(validateUnrealModels(input), { kind: 'TOOLCHAIN_CHANGED' });
  assert.equal(technicalCalls, 0);
  await upgradeModelingToolchain({ ...f.options, apply: true });
  // The fixture's router identity may be synthetic on unconfigured CI hosts.
  const lock = await readJson(f.engine.lockFile);
  await atomicJson(f.engine.lockFile, { ...lock, runtime: await modelingRuntimeIdentity(f.invocation, f.project) });
  const result = await validateUnrealModels(input);
  assert.equal(result.status, 'ENGINE_PROVISIONAL'); assert.equal(result.score, 0);
  assert.equal(technicalCalls, 1);
  const after = await readJson(f.engineExecutionFile);
  assert.equal(after.nextCall, 5); assert.deepEqual(after.groups.retained, original.groups.retained);
  assert.equal((await readJson(f.productionFile)).attempts, 11);
});
