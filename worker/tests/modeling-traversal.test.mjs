import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultContract, preservesContract } from '../agent/modeling-contract.mjs';
import { validateSpecs, validateSchema, modelingPlanV2Schema } from '../agent/modeling-evaluation.mjs';

const traversal = { version: 1, space: 'asset-local-meters', capsule: { radiusMeters: .42, halfHeightMeters: .96, axis: 'Z' },
  marginMeters: .005, paths: [{ id: 'center', startMeters: [0,-1,.97], endMeters: [0,1,.97] }], ueQuery: { channel: 'Visibility', traceComplex: false } };
const contract = defaultContract({ runtime: { engine: 'unreal', profile: 'fbx-static', collision: 'convex', lodTriangles: [], sockets: [], animations: [], lightmapUV: false } });
const spec = { assetId: 'door', description: 'Door', prompt: 'Door', requirements: ['Empty doorway'], referenceImages: [], maxTriangles: 1000, requireRig: false, requireClosedMesh: false, contract };
test('old v2 contracts retain their serialized identity; generated contracts require nullable traversal', () => {
  const json = JSON.stringify(spec);
  validateSpecs({ reason: 'legacy frozen input', assets: [spec] });
  assert.equal(JSON.stringify(spec),json);
  assert.throws(() => validateSpecs({ reason: 'missing player size', assets: [{ ...spec, description: 'A traversable doorway', contract: { ...contract, traversal: null } }] }), e => e.kind === 'CONTRACT_INCOMPLETE');
  assert.throws(() => validateSchema({ reason: 'new intake', assets: [spec] },modelingPlanV2Schema),/traversal/);
  validateSchema({ reason: 'new intake', assets: [{ ...spec, contract: { ...contract, traversal: null } }] },modelingPlanV2Schema);
});
test('valid traversal is immutable and invalid capsule/path/profile semantics fail', () => {
  const current = { ...spec, contract: { ...contract, traversal } };
  validateSpecs({ reason: 'new', assets: [current] });
  assert.equal(preservesContract(current,spec),false);
  for (const mutate of [
    t => { t.capsule.radiusMeters = 0; },
    t => { t.capsule.halfHeightMeters = .1; },
    t => { t.paths[0].endMeters = [...t.paths[0].startMeters]; },
    t => { t.paths.push({ ...t.paths[0] }); },
    t => { t.ueQuery.traceComplex = true; },
    t => { t.paths[0].startMeters[0] = Infinity; },
  ]) {
    const changed = structuredClone(traversal); mutate(changed);
    assert.throws(() => validateSpecs({ reason: 'invalid', assets: [{ ...spec, contract: { ...contract, traversal: changed } }] }));
  }
  assert.throws(() => validateSpecs({ reason: 'bad profile', assets: [{ ...spec, contract: defaultContract({ traversal }) }] }),/static FBX/);
});
