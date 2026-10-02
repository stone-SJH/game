import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicJson, hashFile, readJson } from '../agent/modeling-io.mjs';
import { defaultContract } from '../agent/modeling-contract.mjs';
import { searchModelingAsset, canSearchAfterGenerationFailure } from '../agent/modeling-search-fallback.mjs';

function model(external = false) {
  const json = JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], meshes: [{}],
    buffers: external ? [{ uri: 'https://outside.test/geometry.bin' }] : [] });
  const data = Buffer.from(json.padEnd(Math.ceil(json.length / 4) * 4, ' ')), bytes = Buffer.alloc(20 + data.length);
  bytes.write('glTF'); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(data.length, 12); bytes.write('JSON', 16); data.copy(bytes, 20); return bytes;
}

async function fixture(t, mutate = value => value) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'search-fallback-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'); await fs.mkdir(project);
  let calls = 0;
  const args = { project, spec: { assetId: 'tree', description: 'One tree', prompt: 'A detailed tree', requirements: ['One tree'],
    referenceImages: [], contract: defaultContract({ assetClass: 'organic-static' }) },
  job: { revisionId: 'revision-1' }, iteration: 1, kind: 'model', failure: { reasonCode: 'provider_timeout' },
  review: async (name, schema, prompt, images, options) => {
    calls++; assert.equal(name, 'modeling-asset-search'); assert.equal(options.research, true); assert.equal(options.maxCalls, 2);
    const directory = prompt.match(/under (art\/sourced-assets\/[a-z0-9/-]+)\/downloads\//)[1];
    const file = directory + '/downloads/tree.glb', licenseEvidenceFile = directory + '/downloads/source-page.txt';
    await fs.writeFile(path.join(project, file), model());
    const licenseUrl = 'https://creativecommons.org/licenses/by/4.0/';
    await fs.writeFile(path.join(project, licenseEvidenceFile), 'Creator fixture: this tree asset is licensed under ' + licenseUrl);
    const row = { file, originalFile: file, sha256: await hashFile(path.join(project, file)), originalSha256: await hashFile(path.join(project, file)),
      sourceUrl: 'https://assets.example.org/tree', downloadUrl: 'https://assets.example.org/tree.glb', title: 'Tree', author: 'Fixture creator',
      attribution: 'Tree by Fixture creator, CC-BY-4.0', license: 'CC-BY-4.0', licenseUrl, licenseEvidenceFile,
      licenseEvidenceSha256: await hashFile(path.join(project, licenseEvidenceFile)), suitability: 'Candidate only; all model checks remain required.' };
    const result = await mutate({ candidates: [row], reason: 'Downloaded original with source and license evidence.' }, { project, directory });
    await options.validate(result); return result;
  } };
  return { project, args, calls: () => calls };
}

test('only identified infrastructure failures can start acquisition; content and execution fences remain blocked', () => {
  for (const reasonCode of ['image_timeout', 'image_http_503', 'image_response_unavailable', 'provider_timeout', 'request_timeout', 'network_error', 'insufficient_credits']) {
    assert.equal(canSearchAfterGenerationFailure({ reasonCode }), true, reasonCode);
    assert.equal(canSearchAfterGenerationFailure({ reasonCode, requiresInputChange: true }), false);
    assert.equal(canSearchAfterGenerationFailure({ reasonCode, kind: 'IMAGE_INPUT_REJECTED' }), false);
    assert.equal(canSearchAfterGenerationFailure({ reasonCode, responseEvidence: { code: 'moderation_blocked' } }), false);
    assert.equal(canSearchAfterGenerationFailure({ reasonCode, stopConfirmed: false }), false);
    assert.equal(canSearchAfterGenerationFailure({ reasonCode }, { external3DAllowed: false }), false);
  }
  for (const reasonCode of ['image_http_400', 'task_failed', 'forbidden', 'provider_contract_error', 'moderation_blocked']) assert.equal(canSearchAfterGenerationFailure({ reasonCode }), false);
  const signal = AbortSignal.abort(); assert.equal(canSearchAfterGenerationFailure({ reasonCode: 'provider_timeout' }, { signal }), false);
});

test('licensed downloads are retained and hash-verified across rounds and revisions without another search', async t => {
  const f = await fixture(t), first = await searchModelingAsset(f.args);
  assert.equal(first.status, 'FOUND'); assert.equal(first.candidates[0].license, 'CC-BY-4.0');
  assert.ok(first.evidence.some(row => row.file.endsWith('source-page.txt')));
  assert.deepEqual(await searchModelingAsset({ ...f.args, iteration: 2, job: { revisionId: 'revision-2' } }), first);
  assert.equal(f.calls(), 1);
  await fs.appendFile(path.join(f.project, first.candidates[0].file), 'changed');
  await assert.rejects(searchModelingAsset(f.args), { kind: 'INTEGRITY_ERROR' });
});

test('a missing source is a retained GAP for the revision, never a successful asset or a per-round search loop', async t => {
  const f = await fixture(t, () => ({ candidates: [], reason: 'No downloadable licensed model was found.' }));
  assert.equal((await searchModelingAsset(f.args)).status, 'GAP');
  assert.equal((await searchModelingAsset({ ...f.args, iteration: 2 })).status, 'GAP');
  assert.equal(f.calls(), 1);
});

for (const fault of ['html', 'external-buffer', 'license', 'private-url', 'wrong-hash']) {
  test(`search ${fault} evidence cannot enter authoring`, async t => {
    const f = await fixture(t, async (value, { project }) => {
      const row = value.candidates[0], file = path.join(project, row.file);
      if (fault === 'html') await fs.writeFile(file, '<html>This is not a downloadable asset, only its preview page.</html>');
      if (fault === 'external-buffer') await fs.writeFile(file, model(true));
      if (fault === 'license') row.licenseUrl = 'https://example.org/unknown-license';
      if (fault === 'private-url') row.downloadUrl = 'https://127.0.0.1/model.glb';
      row.sha256 = row.originalSha256 = await hashFile(file);
      if (fault === 'wrong-hash') row.sha256 = '0'.repeat(64);
      return value;
    });
    if (fault === 'wrong-hash') await assert.rejects(searchModelingAsset(f.args), { kind: 'INTEGRITY_ERROR' });
    else assert.equal((await searchModelingAsset(f.args)).status, 'GAP');
  });
}

test('cancellation and unconfirmed tools do not launch or conceal a fallback', async t => {
  const f = await fixture(t);
  assert.equal(await searchModelingAsset({ ...f.args, failure: { kind: 'IMAGE_INPUT_REJECTED', reasonCode: 'image_http_400' } }), null);
  assert.equal(f.calls(), 0);
  await assert.rejects(searchModelingAsset({ ...f.args, review: async () => { throw Object.assign(new Error('Process may still be writing'), { stopConfirmed: false }); } }), /still be writing/);
});
