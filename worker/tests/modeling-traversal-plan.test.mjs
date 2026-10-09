import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareTraversalPlan, validateTraversalPlan } from '../agent/modeling-traversal-plan.mjs';
import { atomicJson, readJson } from '../agent/modeling-io.mjs';

const spec = { contract: { traversal: { paths: [{ id: 'walk' }, { id: 'raised' }] } } };
const engineering = { designDecisions: ['Walk is level; raised rotates the bridge 15 degrees around X at origin.'] };
const manifest = { rootObject: 'ROOT', stateBindings: { vertices: 'untrusted author claim' },
  objects: [{ name: 'ROOT', role: 'helper' }, { name: 'joint', role: 'helper', parent: 'ROOT' }, { name: 'collider', role: 'collision' }] };
const plan = { reason: 'Use the frozen poses', states: ['walk', 'raised'].map((pathId, i) => ({ pathId,
  instructionQuote: engineering.designDecisions[0], rotations: [{ objectName: 'joint', pivotMeters: [0, 0, 0], eulerDegrees: [i * 15, 0, 0] }] })) };

test('pose bindings require all paths, literal authority and shared assembly helpers', () => {
  assert.equal(validateTraversalPlan(plan, spec, manifest, engineering), plan);
  for (const mutate of [p => p.states.pop(), p => p.states.push(p.states[0]),
    p => p.states[0].instructionQuote = 'The author wants it', p => p.states[0].rotations[0].objectName = 'collider',
    p => p.states[0].rotations[0].objectName = 'ROOT', p => p.states[0].rotations[0].eulerDegrees[0] = 400]) {
    const changed = structuredClone(plan); mutate(changed);
    assert.throws(() => validateTraversalPlan(changed, spec, manifest, engineering));
  }
});

test('pose decisions are reviewed once, reject without resampling, and bind source/manifest identity', async t => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'traversal-plan-')); t.after(() => fs.rm(project, { recursive: true, force: true }));
  const directory = 'model', output = path.join(project, 'reports');
  await fs.mkdir(path.join(project, directory));
  await fs.writeFile(path.join(project, directory, 'source.blend'), 'source one');
  await atomicJson(path.join(project, directory, 'asset-manifest.json'), manifest);
  let calls = 0, approved = true;
  const review = async (name, schema, prompt, images, options) => {
    calls++;
    assert.doesNotMatch(prompt, /untrusted author claim/);
    const value = name === 'modeling-traversal-plan' ? plan : { approved, reason: 'Reviewed against frozen engineering.' };
    options.validate?.(value); return value;
  };
  const args = { spec, project, directory, output, engineering, review };
  const file = await prepareTraversalPlan(args); assert.equal(calls, 2);
  assert.equal(await prepareTraversalPlan(args), file); assert.equal(calls, 2);
  const saved = await readJson(file); saved.plan.states[0].rotations[0].eulerDegrees[0] = 3;
  await atomicJson(file, saved);
  await assert.rejects(prepareTraversalPlan(args), { kind: 'INTEGRITY_ERROR' });
  await fs.writeFile(path.join(project, directory, 'source.blend'), 'source two'); approved = false;
  await assert.rejects(prepareTraversalPlan(args), { kind: 'TRAVERSAL_PLAN_UNRESOLVED' });
  await assert.rejects(prepareTraversalPlan(args), { kind: 'TRAVERSAL_PLAN_UNRESOLVED' }); assert.equal(calls, 4);
});
