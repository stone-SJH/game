import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { applyUserAssetChanges, reconcileUserModelingRevision } from '../agent/modeling-user-revision.mjs';
import { composeConceptPrompt, assertGenerationPrompt } from '../agent/modeling-generation-input.mjs';
import { needsVisualResearch } from '../agent/modeling-research.mjs';
import { defaultContract } from '../agent/modeling-contract.mjs';
import { atomicJson, hashValue, readJson } from '../agent/modeling-io.mjs';
import { validateSpecs, validateSchema, modelingRevisionSchema } from '../agent/modeling-evaluation.mjs';

const original = { assetId: 'player', description: 'Detailed player', prompt: 'Historical named character',
  requirements: ['Provide a rig and skin weights', 'Match the old named costume', 'Wait for another host approval'],
  referenceImages: [], maxTriangles: 90000, requireRig: true, requireClosedMesh: false,
  contract: defaultContract({ assetClass: 'skeletal-character', runtime: { ...defaultContract().runtime, profile: 'fbx-skeletal', collision: 'none' } }) };
const prop = { ...structuredClone(original), assetId: 'other-player' };
const current = { reason: 'Retained plan', assets: [original, prop], revisions: 4 };
const instruction = 'Replace only the player with an original adult traveler. Omit Link and 林克 from generation input. Keep the rig and engine contract.';
const proposal = { reason: 'Apply the current player design', changes: [{
  assetId: 'player', instructionQuote: 'Replace only the player with an original adult traveler.', reason: 'User replaces the previous appearance',
  description: 'Original adult traveler', prompt: 'One fully clothed original adult traveler, neutral A-pose',
  requirements: ['Provide a rig and skin weights', 'Original adult traveler with readable layered clothing'],
  supersededRequirements: ['Match the old named costume', 'Wait for another host approval'], referenceImages: [],
  generationInput: { prompt: 'One fully clothed original adult traveler, neutral A-pose',
    requirements: ['Readable layered clothing'], referenceImages: [], excludedTerms: ['Link', '林克'] },
}] };

async function fixture(t, approved = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'user-model-revision-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), taskState = path.join(root, 'state');
  await fs.mkdir(project); await fs.mkdir(taskState);
  await atomicJson(path.join(taskState, 'plan.json'), current);
  const calls = [];
  return { root, project, taskState, calls, current,
    job: { revisionId: 'new-user-revision', payload: { followUpPrompt: instruction } },
    review: async (name, schema, prompt, images, options) => {
      calls.push(name);
      const value = name === 'modeling-user-revision' ? structuredClone(proposal) : { approved, reason: approved ? 'Current user design; technical obligations retained.' : 'Unjustified removal.' };
      validateSchema(value, schema); await options.validate?.(value); return value;
    } };
}

test('host user revision supersedes exact appearance obligations while retaining every technical field and unrelated asset', () => {
  const next = applyUserAssetChanges(current, proposal, instruction);
  validateSpecs({ reason: next.reason, assets: next.assets });
  validateSchema({ reason: next.reason, assets: next.assets }, modelingRevisionSchema);
  validateSchema({ reason: next.reason, assets: next.assets.map(({ contract, ...asset }) => asset) }, modelingRevisionSchema);
  assert.deepEqual(next.assets[1], prop);
  for (const key of ['contract', 'maxTriangles', 'requireRig', 'requireClosedMesh']) assert.deepEqual(next.assets[0][key], original[key]);
  assert.equal(next.revisions, 5);
  assert.deepEqual(current.assets[0], original);
  assert.throws(() => applyUserAssetChanges(current, proposal, 'Continue.'), /cite the current instruction/);
  const bad = structuredClone(proposal); bad.changes[0].supersededRequirements.pop();
  assert.throws(() => applyUserAssetChanges(current, bad, instruction), /supersession record/);
  const overreported = structuredClone(proposal);
  overreported.changes[0].supersededRequirements.push(original.prompt, original.description);
  assert.throws(() => applyUserAssetChanges(current, overreported, instruction), error => {
    assert.deepEqual(error.validationIssues[0].expectedSupersededRequirements, proposal.changes[0].supersededRequirements);
    assert.deepEqual(error.validationIssues[0].unexpected, [original.prompt, original.description]);
    assert.deepEqual(error.validationIssues[0].missing, []);
    return true;
  });
});

test('provider input excludes history and comparison references; final composed and repair text are checked', () => {
  const spec = applyUserAssetChanges(current, proposal, instruction).assets[0];
  spec.requirements.push('Historical 林克 / Link obligations are archived. 原作对照');
  spec.referenceImages.push('comparison-only.jpg');
  assert.equal(needsVisualResearch(spec), false);
  const prompt = composeConceptPrompt(spec);
  assert.doesNotMatch(prompt, /林克|Link|archived|host approval|rig and skin/i);
  assert.match(prompt, /Readable layered clothing/);
  assertGenerationPrompt(spec, 'Visible blinking eyes and a linked belt');
  assert.throws(() => composeConceptPrompt(spec, 'Match Link'), error => error.kind === 'GENERATION_INPUT_CONFLICT');
  assert.throws(() => composeConceptPrompt(spec, '', 'Restore 林克'), error => error.requiresInputChange === true);
});

test('reviewed revision archives obsolete requests, resumes without extra calls and preserves later repairs', async t => {
  const f = await fixture(t);
  const pending = path.join(f.taskState, 'revision-pending.json'), request = path.join(f.project, 'plan/modeling-request.json');
  await atomicJson(pending, { iteration: 3, rawRequest: JSON.stringify(current) });
  await atomicJson(request, current);
  const first = await reconcileUserModelingRevision(f);
  assert.equal(first.current.assets[0].generationInput.prompt, proposal.changes[0].generationInput.prompt);
  assert.equal(await readJson(pending), null); assert.equal(await readJson(request), null);
  const receipt = await readJson(first.recordFile);
  assert.deepEqual(receipt.before, current); assert.equal(receipt.staleRequests.length, 2);
  assert.equal(receipt.initialProviderInputs[0].submitted, false);
  assert.equal(receipt.initialProviderInputs[0].prompt, composeConceptPrompt(first.current.assets[0]));
  assert.equal(receipt.status, 'APPLIED'); assert.equal(f.calls.length, 2);
  const later = { ...first.current, reason: 'Later production repair' };
  await atomicJson(request, later);
  const resumed = await reconcileUserModelingRevision({ ...f, current: later });
  assert.deepEqual(resumed.current, later); assert.deepEqual(await readJson(request), later);
  assert.equal(f.calls.length, 2);
  const interrupted = await reconcileUserModelingRevision(f);
  assert.deepEqual(interrupted.current, first.current); assert.equal(f.calls.length, 2);
});

test('independent rejection prevents activation and cannot be resampled into approval', async t => {
  const f = await fixture(t, false), before = hashValue(await readJson(path.join(f.taskState, 'plan.json')));
  await assert.rejects(reconcileUserModelingRevision(f), error => error.kind === 'USER_REVISION_UNRESOLVED' && error.productionIncomplete);
  await assert.rejects(reconcileUserModelingRevision(f), /Unjustified removal/);
  assert.equal(f.calls.length, 2);
  assert.equal(hashValue(await readJson(path.join(f.taskState, 'plan.json'))), before);
});

test('a task without a controller-owned follow-up cannot obtain a relaxed asset plan', async t => {
  const f = await fixture(t);
  const result = await reconcileUserModelingRevision({ ...f, job: { revisionId: 'new-user-revision' } });
  assert.equal(result.current, current); assert.equal(f.calls.length, 0);
});
