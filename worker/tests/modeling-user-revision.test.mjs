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

test('one generic revision handles multiple non-character assets with separate visual constraints', () => {
  const cases = [
    { assetId: 'delivery-cart', assetClass: 'static-prop', excluded: 'Aster-42', prompt: 'A blue metal cart with two oak wheels' },
    { assetId: 'garden-gateway', assetClass: 'modular-kit', excluded: 'Beacon', prompt: 'A blue stone gateway with fluted columns' },
    { assetId: 'coral-formation', assetClass: 'organic-static', excluded: '珊瑚王', prompt: 'A blue branching coral formation with porous surfaces' },
  ];
  const assets = cases.map(row => ({ assetId: row.assetId, description: row.assetId, prompt: 'Red ' + row.assetId,
    requirements: ['Retain the original collision and texture budgets', 'Red surfaces'], referenceImages: [],
    maxTriangles: 10000, requireRig: false, requireClosedMesh: true, contract: defaultContract({ assetClass: row.assetClass }) }));
  const base = { reason: 'Independent asset specifications', assets: [...assets, structuredClone(prop)], revisions: 2 };
  const instruction = 'Make the cart, gateway and coral blue; omit each designated catalog name from its generation input.';
  const changes = cases.map((row, index) => ({ assetId: row.assetId, instructionQuote: instruction, reason: 'Requested blue surface and omitted catalog name',
    description: row.assetId, prompt: row.prompt, requirements: [assets[index].requirements[0], 'Blue surfaces'],
    supersededRequirements: ['Red surfaces'], referenceImages: [],
    generationInput: { prompt: row.prompt, requirements: ['Blue surfaces'], referenceImages: [], excludedTerms: [row.excluded] } }));
  const next = applyUserAssetChanges(base, { reason: 'Apply the scoped multi-asset change', changes }, instruction);
  assert.deepEqual(next.assets[3], base.assets[3]);
  for (let index = 0; index < cases.length; index++) {
    assert.deepEqual(next.assets[index].contract, base.assets[index].contract);
    assert.deepEqual(next.assets[index].requirements, [base.assets[index].requirements[0], 'Blue surfaces']);
    assert.match(composeConceptPrompt(next.assets[index]), /Blue surfaces/);
    assert.throws(() => assertGenerationPrompt(next.assets[index], cases[index].excluded), error => error.kind === 'GENERATION_INPUT_CONFLICT');
    assertGenerationPrompt(next.assets[index], cases[(index + 1) % cases.length].excluded);
  }
  assert.deepEqual(base.assets.map(asset => asset.prompt), [...cases.map(row => 'Red ' + row.assetId), prop.prompt]);
});

test('approval and rejection records are isolated across task workspaces even with equal revision labels', async t => {
  const approved = await fixture(t, true), rejected = await fixture(t, false);
  const accepted = await reconcileUserModelingRevision(approved);
  await assert.rejects(reconcileUserModelingRevision(rejected), error => error.kind === 'USER_REVISION_UNRESOLVED');
  const resumed = await reconcileUserModelingRevision({ ...approved, current: accepted.current });
  assert.deepEqual(resumed.current, accepted.current);
  assert.equal(approved.calls.length, 2); assert.equal(rejected.calls.length, 2);
  assert.deepEqual(await readJson(path.join(rejected.taskState, 'plan.json')), current);
});

test('a generic continuation with no asset change does not alter inputs or archive pending work', async t => {
  const f = await fixture(t), pending = path.join(f.taskState, 'revision-pending.json');
  await atomicJson(pending, { iteration: 2, rawRequest: 'Retained pending repair' });
  const before = await fs.readFile(pending, 'utf8'); let calls = 0;
  const args = { ...f, job: { revisionId: 'continue-revision', payload: { followUpPrompt: 'Continue the existing work.' } },
    review: async name => { assert.equal(name, 'modeling-user-revision'); calls++; return { reason: 'No asset input change requested', changes: [] }; } };
  const result = await reconcileUserModelingRevision(args);
  await reconcileUserModelingRevision({ ...args, current: result.current });
  assert.deepEqual(result.current, current); assert.equal(calls, 1);
  assert.equal(await fs.readFile(pending, 'utf8'), before);
});

test('explicit dimension amendments preserve other contracts and atomically resume engineering projections', async t => {
  const f = await fixture(t);
  f.current = structuredClone(current);
  f.current.assets[0].contract.dimensions = { meters: [1.4, .6, 1.75], toleranceMeters: .01 };
  const before = f.current.assets[0].contract.dimensions;
  const instruction = 'For player, change only the depth target to 0.32 meters, keeping its 0.01 meter tolerance and other dimensions.';
  const p = { reason: 'User approves natural depth', changes: [{ ...structuredClone(proposal.changes[0]),
    instructionQuote: instruction, requirements: [...original.requirements], supersededRequirements: [],
    dimensionAmendment: { instructionQuote: instruction, before, after: { ...before, meters: [1.4, .32, 1.75] } } }] };
  const engineering = { assets: f.current.assets.map(a => ({ assetId: a.assetId, contract: a.contract, designDecisions: ['Retained decision'] })) };
  await atomicJson(path.join(f.taskState, 'plan.json'), f.current);
  await atomicJson(path.join(f.taskState, 'engineering-plan.json'), engineering);
  await atomicJson(path.join(f.project, 'plan/engineering-plan.json'), engineering);
  let calls = 0;
  const args = { ...f, job: { revisionId: 'dimension-revision', payload: { followUpPrompt: instruction } },
    review: async (name, schema, prompt, images, options) => { calls++; const value = name === 'modeling-user-revision' ? p : { approved: true, reason: 'Explicit depth change only.' };
      await options.validate?.(value); return value; } };
  const result = await reconcileUserModelingRevision(args);
  const after = result.current.assets[0].contract;
  assert.deepEqual(after.dimensions.meters, [1.4, .32, 1.75]);
  assert.deepEqual({ ...after, dimensions: before }, f.current.assets[0].contract);
  assert.deepEqual(result.current.assets[1], f.current.assets[1]);
  const record = await readJson(result.recordFile);
  assert.deepEqual(record.engineering.before, engineering);
  assert.deepEqual((await readJson(path.join(f.project, 'plan/engineering-plan.json'))).assets[0].contract, after);
  // Simulate interruption between activation of the state and visible engineering copies.
  await atomicJson(path.join(f.project, 'plan/engineering-plan.json'), engineering);
  await reconcileUserModelingRevision(args); assert.equal(calls, 2);
  assert.deepEqual((await readJson(path.join(f.project, 'plan/engineering-plan.json'))).assets[0].contract, after);
  const stale = structuredClone(p); stale.changes[0].dimensionAmendment.before.meters[1] = .7;
  assert.throws(() => applyUserAssetChanges(f.current, stale, instruction), /match the current dimensions/);
  assert.throws(() => applyUserAssetChanges(f.current, p, 'Continue.'), /cite/);
});
