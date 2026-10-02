import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { coverageFirst, readSceneCoverage, coverageStalled, coverageImproved, extendCoveragePlan } from '../agent/modeling-coverage.mjs';
import { defaultContract } from '../agent/modeling-contract.mjs';
import { atomicJson, hashFile } from '../agent/modeling-io.mjs';

const job = { taskId: 'task', workspaceId: 'workspace', runId: 'run', objective: '先将场景所有白模、placeholder、地形全部建模和做材质，然后再逐个提升细节质量。' };
test('coverage priority follows the requested ordering and does not activate on an unrelated detail request', () => {
  assert.equal(coverageFirst(job), true);
  assert.equal(coverageFirst({ objective: 'Complete every placeholder before refining detail.' }), true);
  assert.equal(coverageFirst({ objective: 'Refine the door handle.' }), false);
});

test('material coverage cannot pass formal coverage, and current evidence must contain verified source/export bindings', async t => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'coverage-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const report = { ...job, iteration: 1, actors: [{ label: 'rock', assetId: 'rock-kit', category: 'visible-engine-native-temporary', materials: ['M_Rock'] }],
    engineNativeProvisionalActors: ['rock'], missingOrDefaultMaterialActors: [], coverageStatus: 'PASS', finalBlenderSourceCompliance: 'GAP' };
  const file = path.join(project, 'acceptance/scene-coverage.json');
  await atomicJson(file, report);
  const before = await readSceneCoverage(project, job, 1);
  assert.equal(before.status, 'GAP'); assert.equal(before.remaining, 1);
  report.actors[0].category = 'authored'; report.engineNativeProvisionalActors = []; report.finalBlenderSourceCompliance = 'PASS';
  await atomicJson(file, report);
  assert.equal((await readSceneCoverage(project, job, 1)).status, 'GAP');
  await fs.writeFile(path.join(project, 'source.blend'), 'authored Blender source');
  await fs.writeFile(path.join(project, 'model.fbx'), 'export');
  Object.assign(report.actors[0], { formalBlenderSource: 'source.blend', immutableFBX: { path: 'model.fbx', sha256: await hashFile(path.join(project, 'model.fbx')) } });
  await atomicJson(file, report);
  const complete = await readSceneCoverage(project, job, 1);
  assert.equal(complete.status, 'PASS'); assert.equal(coverageImproved(before, complete), true);
  const prior = await readSceneCoverage(project, { ...job, runId: 'next-run' }, 1);
  assert.equal(prior.complete, true); assert.equal(prior.status, 'GAP');
  await fs.appendFile(path.join(project, 'model.fbx'), 'changed');
  assert.equal((await readSceneCoverage(project, job, 1)).status, 'GAP');
});

test('coverage stagnation uses unchanged deficits even when package bytes change', () => {
  const rounds = [1, 2, 3].map(n => ({ packageDigest: String(n), score: 0, coverage: { current: true, status: 'GAP', remaining: 53, fingerprint: 'same-53' } }));
  assert.equal(coverageStalled(rounds), true);
  rounds[2].coverage = { current: true, status: 'GAP', remaining: 1, fingerprint: 'only-terrain' };
  assert.equal(coverageStalled(rounds), false);
  assert.equal(coverageImproved(rounds[1].coverage, rounds[2].coverage), true);
  rounds[2].coverage.current = false;
  assert.equal(coverageStalled(rounds), false);
});

test('missing peripheral terrain gets a separate contract without changing the frozen core', async () => {
  const core = { assetId: 'core', description: 'Core', prompt: 'Core', requirements: ['Keep 8m core'], referenceImages: [],
    maxTriangles: 1000, requireRig: false, requireClosedMesh: true, contract: defaultContract({ dimensions: { meters: [8, 8, .3], toleranceMeters: .02 }, pivot: { mode: 'base-center', meters: null, toleranceMeters: 0 } }) };
  const current = { reason: 'Original', assets: [core], revisions: 4 };
  const terrain = { ...structuredClone(core), assetId: 'terrain', contract: defaultContract({ traversal: null }) };
  const args = { current, coverage: { targets: [{ label: 'far-soil', assetId: 'terrain' }] }, iteration: 10, timeoutMs: 1000 };
  const result = await extendCoveragePlan({ ...args, review: async (name, schema, prompt, images, options) => {
    const changedCore = structuredClone(core); changedCore.contract.dimensions.meters[0] = 80;
    assert.throws(() => options.validate({ reason: 'Altered', assets: [changedCore, terrain] }), /preserve/);
    assert.throws(() => options.validate({ reason: 'Missing', assets: [core] }), /missing coverage/);
    const plan = { reason: 'Separate peripheral replacement', assets: [core, terrain] }; options.validate(plan); return plan;
  } });
  assert.equal(result.revisions, 5); assert.deepEqual(result.assets[0], core); assert.equal(result.assets[1].assetId, 'terrain');
});

test('native systems without render geometry do not stall formal asset coverage', async t => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'coverage-systems-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  await fs.writeFile(path.join(project, 'rock.blend'), 'authored rock');
  await fs.writeFile(path.join(project, 'rock.fbx'), 'exported rock');
  const rock = { label: 'rock', actorClass: 'StaticMeshActor', mesh: '/Game/Rock', category: 'authored',
    materials: ['M_Rock'], formalBlenderSource: 'rock.blend',
    immutableFBX: { path: 'rock.fbx', sha256: await hashFile(path.join(project, 'rock.fbx')) } };
  const systems = ['SkyAtmosphere', 'DirectionalLight', 'SkyLight', 'PointLight', 'SpotLight', 'RectLight',
    'ExponentialHeightFog', 'PostProcessVolume', 'PlayerStart', 'CameraActor', 'CineCameraActor'].map(actorClass => ({
    label: actorClass, actorClass, mesh: null, materials: [], renderMeshComponentCount: 0,
    editorMeshComponents: /Camera/.test(actorClass) ? [{ editorOnly: true, hiddenInGame: true, visible: true }] : [],
  }));
  const report = { ...job, iteration: 1, actors: [rock, ...systems], engineNativeProvisionalActors: [],
    missingOrDefaultMaterialActors: [], finalBlenderSourceCompliance: 'PASS' };
  const file = path.join(project, 'acceptance/scene-coverage.json');
  await atomicJson(file, report);
  const coverage = await readSceneCoverage(project, job, 1);
  assert.equal(coverage.status, 'PASS'); assert.deepEqual(coverage.sourceProblems, []);
  assert.equal(coverageStalled([1, 2, 3].map(() => ({ coverage }))), false);
  assert.equal((await readSceneCoverage(project, { ...job, runId: 'next-run' }, 1)).status, 'GAP');

  // Material/source exemptions cannot conceal missing evidence or runtime geometry.
  const camera = systems.find(actor => actor.actorClass === 'CameraActor');
  for (const change of [
    { actorClass: 'StaticMeshActor', category: 'camera', sourceRequired: false },
    { actorClass: 'BP_Camera_C' }, { mesh: '/Game/VisibleCameraHousing' }, { mesh: undefined },
    { renderMeshComponentCount: 1 }, { renderMeshComponentCount: undefined },
    { editorMeshComponents: undefined }, { editorMeshComponents: [{}] },
    { editorMeshComponents: [{ editorOnly: false, hiddenInGame: false, visible: true }] },
  ]) {
    report.actors = [rock, { ...camera, ...change }];
    await atomicJson(file, report);
    const result = await readSceneCoverage(project, job, 1);
    assert.equal(result.status, 'GAP', JSON.stringify(change));
    assert.deepEqual(result.sourceProblems, ['CameraActor']);
  }
  report.actors = [rock, ...systems];
  await atomicJson(file, report);
  await fs.appendFile(path.join(project, 'rock.fbx'), 'changed');
  assert.deepEqual((await readSceneCoverage(project, job, 1)).sourceProblems, ['rock']);
});
