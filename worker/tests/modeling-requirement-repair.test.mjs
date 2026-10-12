import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyRequirementRepairs, applyUserAssetChanges, reconcileUserModelingRevision } from '../agent/modeling-user-revision.mjs';
import { defaultContract } from '../agent/modeling-contract.mjs';
import { atomicJson, hashValue, readJson } from '../agent/modeling-io.mjs';
import { createModelingReviewer } from '../agent/modeling-review.mjs';
import { createExecutionStore } from '../agent/modeling-execution.mjs';
import { composeConceptPrompt } from '../agent/modeling-generation-input.mjs';

const instruction = 'Use cel shading for the traveler and soft outdoor lighting for the gate. Preserve the technical contracts.';
const stale = '升起后的净空须由实际玩家胶囊和资产局部通行路径验证；目前 traversal 保持 null。';
const replacement = '升起后的净空须使用现有 contract.traversal，由实际玩家胶囊和资产局部通行路径验证，不得清空合同。';
const traveler = { assetId: 'traveler', description: 'Layered traveler', prompt: 'Traveler in layered clothing',
  requirements: ['Preserve generated-source provenance, rig, skin weights, animation poses and Unreal verification.'],
  referenceImages: [], maxTriangles: 90000, requireRig: true, requireClosedMesh: false,
  contract: defaultContract({ assetClass: 'skeletal-character', runtime: { ...defaultContract().runtime, profile: 'fbx-skeletal' } }) };
const gate = { assetId: 'garden-gate', description: 'Stone garden gate', prompt: 'Carved stone garden gate',
  requirements: [stale, 'Keep separate moving gate collision and verify the raised state in Unreal.'],
  referenceImages: [], maxTriangles: 10000, requireRig: false, requireClosedMesh: true,
  contract: defaultContract({ dimensions: { meters: [4, 1, 3], toleranceMeters: .01 },
    runtime: { ...defaultContract().runtime, profile: 'fbx-static', collision: 'convex' },
    traversal: { version: 1, space: 'asset-local-meters', capsule: { radiusMeters: .35, halfHeightMeters: .9, axis: 'Z' },
      marginMeters: .05, paths: [{ id: 'raised', startMeters: [0, -2, 1], endMeters: [0, 2, 1] }],
      ueQuery: { channel: 'Visibility', traceComplex: false } } }) };
const current = { reason: 'Retained engineering plan', assets: [gate, traveler, { ...traveler, assetId: 'unaffected' }], revisions: 2 };
const proposal = { reason: 'Requested rendering styles', changes: [gate, traveler].map(asset => ({
  assetId: asset.assetId, instructionQuote: instruction, reason: 'Requested rendering only',
  description: asset.description, prompt: asset.prompt, requirements: [...asset.requirements, 'Use the existing technical contract.'],
  supersededRequirements: [], referenceImages: [], generationInput: { prompt: asset.prompt,
    requirements: [asset === gate ? 'Soft outdoor lighting' : 'Cel shading'], referenceImages: [], excludedTerms: ['ArchivedTitle'] },
})) };
const repair = { reason: 'Resolved contract makes the draft-state clause obsolete', replacements: [{ assetId: gate.assetId,
  requirement: stale, replacement, contractField: 'traversal', reason: 'The existing contract already defines a capsule and local path.' }] };
const identity = hashValue({ revisionId: 'render-revision', instruction });
function rejectedRecord() {
  const appliedPlan = applyUserAssetChanges(current, proposal, instruction);
  return { protocol: 1, identity, revisionId: 'render-revision', instruction, status: 'GAP',
    approval: { approved: false, reason: 'Stale null requirement contradicts the existing traversal contract; preserve clearance validation.' },
    proposal, before: current, beforeHash: hashValue(current), appliedPlan, appliedHash: hashValue(appliedPlan),
    initialProviderInputs: proposal.changes.map(change => ({ assetId: change.assetId,
      prompt: composeConceptPrompt(appliedPlan.assets.find(asset => asset.assetId === change.assetId)), referenceImages: [], submitted: false })),
    staleRequests: [] };
}

async function fixture(t, { legacy = false, approved = true, invalidRepair = false, interrupt = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'requirement-repair-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), taskState = path.join(root, 'state'), output = path.join(root, 'run');
  await fs.mkdir(project); await fs.mkdir(output);
  await atomicJson(path.join(taskState, 'plan.json'), current);
  await atomicJson(path.join(taskState, 'engineering-plan.json'), { assets: current.assets.map(({ assetId, contract }) => ({ assetId, contract })) });
  const originalFile = path.join(taskState, `user-revision-${identity}.json`);
  if (legacy) await atomicJson(originalFile, rejectedRecord());
  const execution = createExecutionStore(taskState), calls = [];
  let interrupted = false;
  const invoke = createModelingReviewer({ execution, project, output, invocation: { command: process.execPath, args: [] },
    evaluate: async ({ name, prompt }) => {
      calls.push(name);
      if (name === 'modeling-user-revision') return structuredClone(proposal);
      if (name === 'modeling-user-revision-requirement-repair') {
        assert.match(prompt, /COMPLETE original requirement entry/);
        const value = structuredClone(repair);
        if (invalidRepair) value.replacements[0].requirement = 'traversal stays null';
        return value;
      }
      assert.equal(name, 'modeling-user-revision-review');
      if (!prompt.includes('Requirement repair and original rejection:')) return rejectedRecord().approval;
      assert.match(prompt, /ALL obligations/);
      assert.match(prompt, /HOST-ONLY/);
      return { approved, reason: approved ? 'Existing contract and every verification obligation retained.' : 'Replacement dropped an obligation.' };
    } });
  const review = async (name, schema, prompt, images, options) => {
    if (interrupt && !interrupted && prompt.includes('Requirement repair and original rejection:')) {
      interrupted = true;
      throw Object.assign(new Error('Canceled before repaired proposal review'), { kind: 'CANCELED' });
    }
    return invoke({ name, schema, prompt, images, ...options });
  };
  return { current: structuredClone(current), project, taskState, review, timeoutMs: 10000,
    job: { revisionId: 'render-revision', payload: { followUpPrompt: instruction } }, originalFile, calls, execution };
}

test('whole-entry reconciliation preserves the capsule, paths, other obligations and provider inputs', () => {
  const rejected = rejectedRecord(), fixed = applyRequirementRepairs(rejected, repair);
  assert.deepEqual(fixed.changes[0].supersededRequirements, [stale]);
  assert.deepEqual(fixed.changes[0].requirements, [replacement, ...proposal.changes[0].requirements.slice(1)]);
  const applied = applyUserAssetChanges(current, fixed, instruction);
  assert.deepEqual(applied.assets[0].contract, gate.contract);
  assert.deepEqual(applied.assets.slice(1), rejected.appliedPlan.assets.slice(1));
  assert.equal(composeConceptPrompt(applied.assets[0]), rejected.initialProviderInputs[0].prompt);
  assert.deepEqual(fixed.changes[0].generationInput, proposal.changes[0].generationInput);
  assert.deepEqual(rejected, rejectedRecord());
});

test('reconciliation is independent of asset IDs, language and contract field', () => {
  for (const [contractField, requirement, replacement] of [
    ['dimensions', 'Verify extents in engine; dimensions are currently unknown.', 'Verify extents in engine against the existing dimensions contract.'],
    ['runtime', '保留引擎碰撞验收；导出 profile 尚待确定。', '保留引擎碰撞验收；使用现有 runtime 中的导出 profile。'],
  ]) {
    const record = structuredClone(rejectedRecord());
    for (const asset of [record.before.assets[0], record.appliedPlan.assets[0]]) {
      asset.assetId = 'another-assembly'; asset.requirements[0] = requirement;
    }
    record.proposal.changes[0].assetId = 'another-assembly'; record.proposal.changes[0].requirements[0] = requirement;
    const corrected = applyRequirementRepairs(record, { reason: 'Existing contract resolves draft wording',
      replacements: [{ assetId: 'another-assembly', requirement, replacement, contractField, reason: 'Existing value is binding' }] });
    const next = applyUserAssetChanges(record.before, corrected, instruction);
    assert.deepEqual(corrected.changes[0].supersededRequirements, [requirement]);
    assert.deepEqual(next.assets[0].contract, record.before.assets[0].contract);
    assert.deepEqual(next.assets[1], record.appliedPlan.assets[1]);
  }
});

test('host rejects fragments, no-ops, duplicates, unrelated assets and contract/provider edits', () => {
  for (const mutate of [
    p => { p.replacements[0].requirement = '目前 traversal 保持 null。'; },
    p => { p.replacements[0].replacement = stale; },
    p => { p.replacements.push(p.replacements[0]); },
    p => { p.replacements[0].assetId = 'unaffected'; },
    p => { p.replacements[0].contract = { traversal: null }; },
    p => { p.replacements[0].generationInput = { prompt: 'Different provider input' }; },
  ]) {
    const bad = structuredClone(repair); mutate(bad);
    assert.throws(() => applyRequirementRepairs(rejectedRecord(), bad));
  }
  const missing = structuredClone(rejectedRecord()); missing.appliedPlan.assets[0].contract.traversal = null;
  assert.throws(() => applyRequirementRepairs(missing, repair), /existing contract field/);
});

test('new revision repairs an independent GAP once, archives old requests and preserves later work', async t => {
  const f = await fixture(t), pending = path.join(f.taskState, 'revision-pending.json');
  await atomicJson(pending, { iteration: 7, rawRequest: 'Earlier repair request' });
  const engineering = await fs.readFile(path.join(f.taskState, 'engineering-plan.json'), 'utf8');
  const result = await reconcileUserModelingRevision(f), receipt = await readJson(result.recordFile);
  const originalBytes = await fs.readFile(f.originalFile, 'utf8');
  assert.equal(JSON.parse(originalBytes).status, 'GAP');
  assert.equal(receipt.status, 'APPLIED');
  assert.equal(receipt.requirementRepair.parentHash, hashValue(JSON.parse(originalBytes)));
  assert.notEqual(receipt.identity, identity);
  assert.deepEqual(await readJson(path.join(f.taskState, `user-revision-${receipt.identity}.json`)), receipt);
  assert.deepEqual(receipt.initialProviderInputs, JSON.parse(originalBytes).initialProviderInputs);
  assert.equal(await readJson(pending), null);
  assert.deepEqual(await readJson(pending.replace('.json', `-superseded-${identity}.json`)), { iteration: 7, rawRequest: 'Earlier repair request' });
  assert.equal(await fs.readFile(path.join(f.taskState, 'engineering-plan.json'), 'utf8'), engineering);
  const later = { ...result.current, reason: 'Later internal production work' };
  await atomicJson(pending, { iteration: 8, rawRequest: 'New pending repair' });
  assert.deepEqual((await reconcileUserModelingRevision({ ...f, current: later })).current, later);
  assert.deepEqual((await reconcileUserModelingRevision(f)).current, result.current);
  assert.equal((await readJson(pending)).iteration, 8);
  assert.equal(f.calls.length, 4);
  assert.equal(await fs.readFile(f.originalFile, 'utf8'), originalBytes);
});

test('legacy GAP and cancellation resume use durable repair calls without resampling the original approval', async t => {
  const f = await fixture(t, { legacy: true, interrupt: true });
  const before = await fs.readFile(f.originalFile, 'utf8');
  await assert.rejects(reconcileUserModelingRevision(f), { kind: 'CANCELED' });
  assert.deepEqual(await readJson(path.join(f.taskState, 'plan.json')), current);
  const result = await reconcileUserModelingRevision(f);
  await reconcileUserModelingRevision({ ...f, current: result.current });
  assert.deepEqual(f.calls, ['modeling-user-revision-requirement-repair', 'modeling-user-revision-review']);
  assert.equal(await fs.readFile(f.originalFile, 'utf8'), before);
  const ledger = await readJson(path.join(f.taskState, 'execution.json'));
  assert.equal(Object.values(ledger.groups).reduce((n, group) => n + group.calls.length, 0), 2);
});

test('a rejected corrected proposal stays blocked and cannot start another repair on resume', async t => {
  const f = await fixture(t, { legacy: true, approved: false });
  for (let i = 0; i < 2; i++) await assert.rejects(reconcileUserModelingRevision(f), { kind: 'USER_REVISION_UNRESOLVED' });
  assert.equal(f.calls.length, 2);
  assert.deepEqual(await readJson(path.join(f.taskState, 'plan.json')), current);
});

test('invalid requirement repair exhausts the fixed allowance without resetting it on resume', async t => {
  const f = await fixture(t, { legacy: true, invalidRepair: true });
  for (let i = 0; i < 2; i++) await assert.rejects(reconcileUserModelingRevision(f), { kind: 'VALIDATION_INFRASTRUCTURE_EXHAUSTED' });
  assert.equal(f.calls.length, 2);
  assert.deepEqual(await readJson(path.join(f.taskState, 'plan.json')), current);
});

test('changed baseline and tampered repair evidence fail before activation', async t => {
  const f = await fixture(t, { legacy: true });
  await assert.rejects(reconcileUserModelingRevision({ ...f, current: { ...current, reason: 'Changed elsewhere' } }), { kind: 'INTEGRITY_ERROR' });
  assert.equal(f.calls.length, 0);
  const result = await reconcileUserModelingRevision(f), record = await readJson(result.recordFile);
  record.requirementRepair.repair.replacements[0].replacement = 'Skip validation';
  await atomicJson(path.join(f.taskState, `user-revision-${record.identity}.json`), record);
  await assert.rejects(reconcileUserModelingRevision(f), { kind: 'INTEGRITY_ERROR' });
  assert.equal(f.calls.length, 2);
});
