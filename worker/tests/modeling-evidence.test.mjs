import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authorEvidence } from '../agent/modeling-evidence.mjs';
import { needsVisualResearch, prepareModelingReferences } from '../agent/modeling-research.mjs';
import { createModelingReviewer } from '../agent/modeling-review.mjs';
import { createExecutionStore } from '../agent/modeling-execution.mjs';
import { atomicJson, hashFile, readJson } from '../agent/modeling-io.mjs';
import { reviewPasses } from '../agent/modeling-evaluation.mjs';
import { defaultContract } from '../agent/modeling-contract.mjs';
import { visualEvidence, visualReviewPrompt } from '../agent/modeling-rubric.mjs';

const spec = { assetId: 'shrine', prompt: '依据原作镜头复刻', requirements: ['保持原作石材纹样'], contract: defaultContract(), referenceImages: [] };
// An actual 1x1 PNG, not a filename standing in for evidence.
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modeling-evidence-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), output = path.join(root, 'run');
  await fs.mkdir(project); await fs.mkdir(output);
  const execution = createExecutionStore(path.join(root, 'state'));
  return { root, project, output, execution, signal: new AbortController().signal, invocation: { command: process.execPath, args: [] } };
}
function researchOptions(f, review) {
  return { project: f.project, assets: [spec], job: { objective: '复刻神庙' }, engineering: null, review, reportProgress: async () => {} };
}
async function referenceResponse(f, prompt, bytes = pixel) {
  const relative = prompt.match(/plan\/modeling-references\/[a-f0-9]+\/iteration-\d+\/images\//)[0] + 'shrine.png';
  const file = path.join(f.project, relative);
  await fs.writeFile(file, bytes);
  return { references: [{ assetId: 'shrine', file: relative, sha256: await hashFile(file),
    sourceUrl: 'https://example.test/original', observation: 'Test image' }], blocked: [] };
}

test('missing replica evidence is acquired before authoring and remains hash pinned across resume', async t => {
  const f = await fixture(t); let calls = 0;
  const reviewer = createModelingReviewer({ ...f, evaluate: async ({ prompt }) => { calls++; return referenceResponse(f, prompt); } });
  const options = researchOptions(f, (name, schema, prompt, images, options) => reviewer({ name, schema, prompt, images, ...options }));
  const result = await prepareModelingReferences(options);
  assert.deepEqual(spec.referenceImages, []);
  assert.equal(result.assets[0].referenceImages.length, 1);
  assert.deepEqual(result.assets[0].contract, spec.contract);
  await prepareModelingReferences(options); assert.equal(calls, 1);
  await fs.appendFile(path.join(f.project, result.assets[0].referenceImages[0]), 'changed');
  await assert.rejects(prepareModelingReferences(options), /Frozen modeling evidence changed/);
  assert.equal(calls, 1);
});

test('HTML returned as an image gets a bounded async repair with retained response evidence', async t => {
  const f = await fixture(t); let calls = 0;
  const reviewer = createModelingReviewer({ ...f, evaluate: async ({ prompt }) => {
    calls++;
    if (calls === 2) assert.match(prompt, /Previous response.*shrine.png/s);
    return referenceResponse(f, prompt, calls === 1 ? Buffer.from('<html>' + 'x'.repeat(80)) : pixel);
  } });
  const result = await prepareModelingReferences(researchOptions(f, (name, schema, prompt, images, options) => reviewer({ name, schema, prompt, images, ...options })));
  assert.equal(calls, 2); assert.equal(result.record.references.length, 1);
  const group = Object.values((await f.execution.snapshot()).groups)[0];
  assert.equal(group.calls.length, 2);
  assert.equal(group.calls[0].error.kind, 'REVIEW_SCHEMA_INVALID');
});

test('unavailable references remain explicit provisional gaps and do not restart research on resume', async t => {
  const f = await fixture(t); let calls = 0;
  const options = researchOptions(f, async () => { calls++; return { references: [], blocked: [{ assetId: 'shrine', reason: 'Original images inaccessible: tested source returned HTTP 403' }] }; });
  for (let i = 0; i < 2; i++) {
    const result = await prepareModelingReferences(options);
    assert.match(result.record.blocked[0].reason, /403/);
    assert.deepEqual(result.assets[0].referenceImages, []);
  }
  assert.equal(calls, 1);
  assert.equal(needsVisualResearch({ ...spec, referenceImages: ['registered.png'] }), false);
  assert.equal(needsVisualResearch({ ...spec, prompt: 'A stone pillar', requirements: ['Grey stone'] }), false);
});

test('author supplements and limitations reach review but cannot replace independent target evidence', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.project, 'asset/evidence'), { recursive: true });
  await fs.writeFile(path.join(f.project, 'asset/evidence/joints.png'), pixel);
  await atomicJson(path.join(f.project, 'asset/build-report.json'), { limitations: ['Room layout remains unconfirmed'] });
  await atomicJson(path.join(f.project, 'asset/self-check.json'), { collisionPieces: 41 });
  const extra = await authorEvidence(f.project, 'asset');
  assert.equal(extra.images.length, 1); assert.equal(extra.files.length, 3);
  const images = visualEvidence(['export.png', ...extra.images]); images[1].role = 'author-supplement';
  const review = { criteria: [{ criterion: spec.requirements[0], status: 'PASS', evidence: 'Visible stone', views: ['image-2'] }], smallEditsOnly: true, repairInstructions: '' };
  assert.throws(() => reviewPasses(review, spec, images), /target evidence/);
  const prompt = visualReviewPrompt({ spec, evidence: images, metrics: {}, context: { authorReports: extra.reports } });
  assert.match(prompt, /Room layout remains unconfirmed/); assert.match(prompt, /41/); assert.match(prompt, /later mandatory gate/);
  await fs.writeFile(path.join(f.project, 'asset/evidence/ignore.txt'), 'not an image');
  assert.equal((await authorEvidence(f.project, 'asset')).images.length, 1);
  await fs.writeFile(path.join(f.project, 'asset/self-check.json'), '{invalid');
  const malformed = await authorEvidence(f.project, 'asset');
  assert.match(malformed.reports['self-check.json'].unavailable, /internal repair/);
  assert.equal(malformed.files.length, 3);
});

test('research outages retain the operation failure instead of manufacturing quality gaps', async t => {
  const f = await fixture(t); let calls = 0;
  const reviewer = createModelingReviewer({ ...f, evaluate: async () => { calls++; throw new Error('upstream 503'); } });
  const options = researchOptions(f, (name, schema, prompt, images, options) => reviewer({ name, schema, prompt, images, ...options }));
  for (let n = 0; n < 2; n++) {
    await assert.rejects(prepareModelingReferences(options), error => error.kind === 'SERVICE_TRANSIENT');
  }
  assert.equal(calls, 1);
  await assert.rejects(prepareModelingReferences({ ...options, iteration: 2 }), error => error.kind === 'SERVICE_TRANSIENT');
  assert.equal(calls, 2);
});

test('oversized optional image does not invalidate other author evidence', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.project, 'asset/evidence'), { recursive: true });
  await fs.writeFile(path.join(f.project, 'asset/evidence/large.png'), Buffer.alloc(10 * 1024 * 1024 + 1));
  await fs.writeFile(path.join(f.project, 'asset/evidence/valid.png'), pixel);
  const result = await authorEvidence(f.project, 'asset');
  assert.deepEqual(result.images, ['asset/evidence/valid.png']);
  assert.equal(result.reports.invalidImages.length, 1);
});
