import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { preserveBlockoutEvidence, verifyBlockoutEvidence } from '../agent/modeling-blockout-evidence.mjs';
import { createExecutionStore, fileEvidence, verifyEvidence } from '../agent/modeling-execution.mjs';
import { atomicJson, hashFile, readJson } from '../agent/modeling-io.mjs';
import { createModelingPipeline } from '../agent/modeling-pipeline.mjs';
import { defaultContract } from '../agent/modeling-contract.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blockout-evidence-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), stateRoot = path.join(root, 'modeling-state');
  const directory = path.join(project, 'art', 'model', 'blockout');
  await fs.mkdir(directory, { recursive: true });
  for (const name of ['recipe.py', 'source.blend', 'asset-manifest.json']) await fs.writeFile(path.join(directory, name), `original ${name}\r\n`);
  const evidence = await fileEvidence(['recipe.py', 'source.blend', 'asset-manifest.json'].map(name => path.join(directory, name)));
  const input = { project, stateRoot, attemptId: 'model-direct-3', evidence };
  const snapshot = await preserveBlockoutEvidence(input);
  return { ...input, snapshot, directory };
}

test('final author cleanup restores original bytes without replaying its completed call or budget', async t => {
  const f = await fixture(t), finalFile = path.join(f.project, 'art/model/model.glb');
  const execution = createExecutionStore(f.stateRoot);
  const request = { key: 'final:model-direct-3', stage: 'AUTHOR', maxCalls: 1, timeoutMs: 10000 };
  let authorCalls = 0;
  const author = async () => {
    authorCalls++;
    await fs.writeFile(finalFile, 'final model');
    await fs.rm(f.directory, { recursive: true });
    return { exitCode: 0, stopConfirmed: true };
  };
  await execution.run(request, author);
  const stateBefore = await fs.readFile(execution.file, 'utf8');
  await assert.rejects(verifyEvidence(f.evidence), error => error.kind === 'INTEGRITY_ERROR');
  const restored = await verifyBlockoutEvidence(f);
  assert.equal(restored.length, 3);
  await verifyEvidence(f.evidence);
  assert.equal(await fs.readFile(finalFile, 'utf8'), 'final model');
  await createExecutionStore(f.stateRoot).run(request, author);
  assert.equal(authorCalls, 1);
  assert.equal(await fs.readFile(execution.file, 'utf8'), stateBefore);
  assert.deepEqual(await verifyBlockoutEvidence(f), []);
  const recovery = await readJson(path.join(path.dirname(f.snapshot.file), 'recovery.json'));
  assert.equal(recovery.restorations.length, 1);
  assert.equal(recovery.restorations[0].status, 'RESTORED');
});

test('modified surviving evidence fences restoration before any missing files are written', async t => {
  const f = await fixture(t);
  await fs.unlink(f.evidence[0].file);
  await fs.writeFile(f.evidence[1].file, 'changed scene');
  await assert.rejects(verifyBlockoutEvidence(f), error => error.kind === 'INTEGRITY_ERROR');
  await assert.rejects(fs.stat(f.evidence[0].file), { code: 'ENOENT' });
  assert.equal(await fs.readFile(f.evidence[1].file, 'utf8'), 'changed scene');
});

test('missing or changed backups cannot be regenerated from surviving working files', async t => {
  for (const mode of ['missing', 'changed']) {
    const f = await fixture(t), backup = path.join(path.dirname(f.snapshot.file), '0.blob');
    if (mode === 'missing') await fs.unlink(backup);
    else await fs.writeFile(backup, 'changed backup');
    await fs.unlink(f.evidence[1].file);
    await assert.rejects(verifyBlockoutEvidence(f), error => error.kind === 'INTEGRITY_ERROR');
    await assert.rejects(fs.stat(f.evidence[1].file), { code: 'ENOENT' });
  }
});

test('legacy evidence without a backup still rejects missing files', async t => {
  const f = await fixture(t);
  await verifyBlockoutEvidence({ ...f, snapshot: undefined });
  await fs.unlink(f.evidence[0].file);
  await assert.rejects(verifyBlockoutEvidence({ ...f, snapshot: undefined }), error => error.kind === 'INTEGRITY_ERROR');
});

test('backup manifest and evidence identities remain pinned', async t => {
  const f = await fixture(t);
  assert.deepEqual(await preserveBlockoutEvidence(f), f.snapshot);
  await assert.rejects(verifyBlockoutEvidence({ ...f, evidence: f.evidence.slice(1) }), error => error.kind === 'INTEGRITY_ERROR');
  await fs.appendFile(f.snapshot.file, '\n');
  await assert.rejects(verifyBlockoutEvidence(f), error => error.kind === 'INTEGRITY_ERROR');
});

test('working directory links cannot redirect restoration outside the project', async t => {
  const f = await fixture(t), outside = path.join(path.dirname(f.project), 'outside');
  await fs.mkdir(outside);
  await fs.rm(f.directory, { recursive: true });
  await fs.symlink(outside, f.directory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyBlockoutEvidence(f), error => error.executionFence === true);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('backup snapshots cannot contain paths outside the project or host state', async t => {
  const f = await fixture(t), outside = path.join(path.dirname(f.project), 'other.txt');
  await fs.writeFile(outside, 'outside');
  await assert.rejects(preserveBlockoutEvidence({ ...f, evidence: await fileEvidence([outside]) }), /workspace path/);
  await assert.rejects(verifyBlockoutEvidence({ ...f, snapshot: { ...f.snapshot, file: outside } }), /workspace path/);
});

test('real pipeline preserves the blockout across final cleanup and resumes without reauthoring', async t => {
  const f = await fixture(t), output = path.join(path.dirname(f.project), 'run');
  await fs.mkdir(output);
  const spec = { assetId: 'fixture', description: 'A red fixture', prompt: 'A red fixture', requirements: ['Red body'],
    referenceImages: [], maxTriangles: 1000, requireRig: false, requireClosedMesh: false, contract: defaultContract() };
  const counts = { author: 0, preview: 0, checkpoint: 0, check: 0 };
  const options = { project: f.project, output,
    job: { taskId: 'task', workspaceId: 'workspace', runId: 'run', objective: spec.description, modelingSpecs: [spec] },
    signal: new AbortController().signal, invocation: { command: process.execPath, args: [] },
    probe: async () => ({ blenderMcpAvailable: true }), provider: { availability: async () => ({ enabled: false }) },
    evaluate: async () => ({ complexity: 'low', precision: 'Game prop', qualityTarget: 'Red body', capabilityCoverage: 'Blender', unknowns: [], confidence: .9,
      candidates: [], direct: { canMeetQuality: true, estimatedMinutes: 1, plan: ['Build'], qualityByCriterion: [{ criterion: 'Red body', achievable: true, evidence: 'Material' }] },
      thirdParty: { assessed: false, preferred: false, smallEditsOnly: false, editMinutes: 0, editPlan: [], qualityByCriterion: [], reason: 'disabled' }, rationale: 'Use Blender' }),
    step: async (name, command, args, timeout, cwd, validate, { input }) => {
      counts.author++;
      const phase = name.includes('-blockout-') ? 'blockout' : 'final';
      const directory = input.match(/Exact output directory \(relative\): (.*?)\. Save/)[1];
      const root = path.join(f.project, directory);
      const attemptId = name.replace(/^modeling-author-/, '').replace(/-(blockout|final)-author-\d+$/, '');
      for (const file of ['source.blend', 'recipe.py', 'asset-manifest.json']) await fs.writeFile(path.join(root, file), `${phase} ${file}`);
      const script = `tools/modeling-mcp/${phase}.py`;
      await fs.mkdir(path.dirname(path.join(f.project, script)), { recursive: true });
      await fs.writeFile(path.join(f.project, script), `# ${phase} fixture`);
      await atomicJson(path.join(output, `modeling-mcp-${attemptId}.json${phase === 'blockout' ? '.blockout.json' : ''}`), {
        calls: [{ tool: 'blender_run_python', exitCode: 0, stopConfirmed: true, scriptFile: script, scriptHash: await hashFile(path.join(f.project, script)) }] });
      if (phase === 'final') {
        assert.match(input, /frozen evidence/);
        await fs.writeFile(path.join(root, 'model.glb'), 'final model');
        await atomicJson(path.join(root, 'build-report.json'), { smallEditsOnly: true });
        await fs.rm(path.join(root, 'blockout'), { recursive: true });
      }
      return { exitCode: 0, stopConfirmed: true };
    },
    blenderMcp: async ({ tool, input }) => {
      const source = path.join(f.project, input.source), sourceHash = await hashFile(source);
      if (tool === 'blender_render_views') {
        counts.preview++;
        const file = path.join(f.project, 'tools/modeling-mcp/preview.png');
        await fs.writeFile(file, 'original preview');
        return { content: [{ type: 'text', text: JSON.stringify({ sourceHash, views: [{ file }] }) }] };
      }
      counts.checkpoint++;
      const file = 'tools/modeling-mcp/checkpoint.blend';
      await fs.copyFile(source, path.join(f.project, file));
      return { content: [{ type: 'text', text: JSON.stringify({ source: input.source, sourceHash, file }) }] };
    },
    check: async ({ directory }) => {
      counts.check++;
      assert.equal(await fs.readFile(path.join(f.project, directory, 'blockout/recipe.py'), 'utf8'), 'blockout recipe.py');
      return { passed: true, smallEditsOnly: true, feedback: { criteria: [] } };
    } };
  const pipeline = createModelingPipeline(options);
  const result = await pipeline.prepare();
  assert.equal(result.assets[0].status, 'DCC_READY');
  assert.ok(result.assets[0].files.some(file => file.path.endsWith('/blockout/recipe.py')));
  await pipeline.verify();
  await createModelingPipeline(options).prepare();
  assert.deepEqual(counts, { author: 2, preview: 1, checkpoint: 1, check: 1 });
});
