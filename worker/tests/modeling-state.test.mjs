import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicJson, readJson } from '../agent/modeling-io.mjs';
import { readModelingState, writeModelingState, modelingFailureSummary } from '../agent/modeling-state.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modeling-state-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, file: path.join(root, 'state.json'), state: { protocol: 2, attempts: { blender_direct: 3 },
    productionIteration: 1, rounds: { 1: { attempts: { blender_direct: 3 }, delivered: 'original' } },
    pending: null, feedback: { geometry: 'x'.repeat(2200000) }, failures: [{ kind: 'VISUAL_GAP' }] } };
}

test('oversized legacy state migrates losslessly to a small index with verified payloads', async t => {
  const f = await fixture(t); await atomicJson(f.file, f.state);
  await assert.rejects(readJson(f.file), e => e.kind === 'MODELING_JSON_TOO_LARGE' && e.file === f.file && e.bytes > e.limit);
  assert.deepEqual(await readModelingState(f.file), f.state);
  await writeModelingState(f.file, f.state);
  const index = await readJson(f.file);
  assert.equal(index.protocol, 3); assert.ok((await fs.stat(f.file)).size < 10000);
  assert.deepEqual(await readModelingState(f.file), f.state);
  await writeModelingState(f.file, f.state);
  assert.equal((await fs.readdir(path.join(f.root, 'payloads'))).length, 1);
  f.state.attempts.blender_direct++;
  await writeModelingState(f.file, f.state);
  assert.deepEqual(await readModelingState(f.file), f.state);
});

test('missing or altered external evidence fences recovery without resetting attempts', async t => {
  const f = await fixture(t); await writeModelingState(f.file, f.state);
  const index = await readJson(f.file), payload = path.join(f.root, index.payloads.feedback.path);
  await fs.appendFile(payload, 'changed');
  await assert.rejects(readModelingState(f.file), { kind: 'INTEGRITY_ERROR' });
  await assert.rejects(writeModelingState(f.file, f.state), { kind: 'INTEGRITY_ERROR' });
  assert.deepEqual(await readJson(f.file), index);
  await fs.unlink(payload);
  await assert.rejects(readModelingState(f.file), { kind: 'INTEGRITY_ERROR' });
});

test('handoff history is a bounded snapshot while original feedback remains intact', () => {
  const failures = [{ kind: 'VISUAL_GAP', feedback: { geometry: 'x'.repeat(2200000) } }];
  const summary = modelingFailureSummary(failures, 'retained/state.json');
  failures.push({ kind: 'later' });
  assert.equal(summary.length, 1); assert.ok(JSON.stringify(summary).length < 300);
  assert.equal(failures[0].feedback.geometry.length, 2200000);
});

test('technical root causes survive handoff alongside their retained evidence', () => {
  const feedback = { reportFile: 'evidence/geometry.json', source: { gates: [
    { id: 'dimensions', status: 'GAP', expected: [1, .6, 2], actual: [1, .32, 2], tolerance: .01 },
    { id: 'triangles', status: 'PASS', actual: 123 },
  ] } };
  const [summary] = modelingFailureSummary([{ kind: 'TECHNICAL_GAP', feedback }], 'state.json');
  assert.equal(summary.findings.length, 1); assert.deepEqual(summary.findings[0].actual, [1, .32, 2]);
  assert.equal(summary.feedbackEvidence.reportFile, 'evidence/geometry.json');
  assert.equal(feedback.source.gates.length, 2);
});
