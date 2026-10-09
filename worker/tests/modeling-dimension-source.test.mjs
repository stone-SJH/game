import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { retainedDimensionSource } from '../agent/modeling-dimension-source.mjs';
import { atomicJson, hashFile } from '../agent/modeling-io.mjs';
import { writeModelingState } from '../agent/modeling-state.mjs';

test('dimension revision retains approved generation and source without transferring or refunding budgets', async t => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'dimension-source-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const stateRoot = path.join(project, 'state'), taskState = path.join(stateRoot, 'task');
  const before = { assetId: 'creature', description: 'An original creature', prompt: 'Original creature', requirements: ['Keep rig'], referenceImages: [],
    generationInput: { prompt: 'One original creature', requirements: ['Dark fur'], referenceImages: [], excludedTerms: [] },
    contract: { dimensions: { meters: [1, 1, 2], toleranceMeters: .01 } } };
  const spec = structuredClone(before); spec.contract.dimensions.meters[1] = .5;
  const record = { identity: 'reviewed', revisionId: 'revision-new', status: 'APPLIED', approval: { approved: true },
    proposal: { changes: [{ assetId: 'creature', dimensionAmendment: { before: before.contract.dimensions, after: spec.contract.dimensions } }] },
    before: { assets: [before] }, appliedPlan: { assets: [spec] } };
  const publish = async () => { await atomicJson(path.join(project, 'plan/modeling-user-revision.json'), record); await atomicJson(path.join(taskState, 'user-revision-reviewed.json'), record); };
  await publish(); await fs.mkdir(path.join(project, 'model'));
  for (const name of ['source.blend', 'base.glb', 'concept.png']) await fs.writeFile(path.join(project, 'model', name), name);
  const generation = { concept: { status: 'APPROVED', evidence: [{ file: path.join(project, 'model/concept.png'), sha256: await hashFile(path.join(project, 'model/concept.png')) }] },
    generatedBase: { modelFile: 'model/base.glb', sha256: await hashFile(path.join(project, 'model/base.glb')) }, iteration: 4 };
  const stateFile = path.join(stateRoot, 'a'.repeat(20), 'state.json');
  await writeModelingState(stateFile, { protocol: 2, spec: before, route: 'image_tripo_blender', attempts: { image_tripo_blender: 2 },
    requirementsHash: 'a'.repeat(64), previousAttemptDirectory: 'model', feedback: { sourceHash: await hashFile(path.join(project, 'model/source.blend')) },
    rounds: { 4: generation } });
  const stateBytes = await fs.readFile(stateFile, 'utf8');
  const args = { spec, stateRoot, taskState, project, revisionId: 'revision-new' };
  const retained = await retainedDimensionSource(args);
  assert.equal(retained.sourcePath, 'model/source.blend'); assert.equal(retained.generation.base.modelFile, 'model/base.glb');
  assert.equal(retained.attempts, undefined); assert.equal(await fs.readFile(stateFile, 'utf8'), stateBytes);
  assert.equal(await retainedDimensionSource({ ...args, revisionId: 'unrelated' }), null);
  record.appliedPlan.assets[0].generationInput.prompt = 'A different creature'; await publish();
  assert.equal(await retainedDimensionSource(args), null);
  record.appliedPlan.assets[0].generationInput.prompt = before.generationInput.prompt; await publish();
  await fs.writeFile(path.join(project, 'model/source.blend'), 'changed source');
  await assert.rejects(retainedDimensionSource(args), { kind: 'INTEGRITY_ERROR' });
});
