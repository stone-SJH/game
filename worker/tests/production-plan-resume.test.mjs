import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { initializeProductionPlans, readProductionPlans, inspectProduction, runProductionHarness } from '../agent/production-harness.mjs';
import { atomicJson, readJson, hashFile } from '../agent/modeling-io.mjs';

const customStages = ['blockout', 'mid-model', 'high-detail-model', 'materials', 'lighting'];
const names = ['production-plan.json', 'stage-manifest.json'];
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'production-plan-resume-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), output = path.join(root, 'run');
  const job = { taskId: 'task', workspaceId: 'workspace', runId: 'old-run', objective: 'Build a game.' };
  const context = { requiredOutputs: ['Game.exe'], qualityCriteria: [] };
  await initializeProductionPlans(project, job, context);
  for (const name of names) {
    const file = path.join(project, 'plan', name), value = await readJson(file);
    value.workspaceId = job.workspaceId; value.revisionId = 'original-revision';
    value.visualStageSequence = customStages;
    value.stages.push(...customStages.map(id => ({ id, status: 'PROVISIONAL', attempts: 7,
      evidence: `stages/${id}/evidence.json`, retained: { decision: 'Keep actual gaps.' } })));
    await atomicJson(file, value);
  }
  return { root, project, output, job, context };
}

test('15-stage historical plans pass read-only preflight and preserve every record across run changes', async t => {
  const f = await fixture(t), originals = await readProductionPlans(f.project, f.job);
  const files = names.map(name => path.join(f.project, 'plan', name));
  const hashes = await Promise.all(files.map(hashFile));
  const checked = await readProductionPlans(f.project, { ...f.job, runId: 'new-run' });
  assert.equal(checked.stageIds.length, 15);
  assert.deepEqual(await Promise.all(files.map(hashFile)), hashes);
  await initializeProductionPlans(f.project, { ...f.job, runId: 'new-run' }, f.context);
  for (const name of names) assert.deepEqual(await readJson(path.join(f.project, 'plan', name)), { ...originals.values[name], runId: 'new-run' });
  const manifestFile = files[1], reordered = await readJson(manifestFile);
  reordered.stages.reverse(); await atomicJson(manifestFile, reordered);
  assert.equal((await readProductionPlans(f.project, f.job)).stageIds.length, 15);
});

for (const mode of ['duplicate', 'missing-required', 'missing-custom', 'unsafe-id', 'foreign-task', 'missing-manifest']) {
  test('invalid ' + mode + ' is rejected before changing plans, context or production budget', async t => {
    const f = await fixture(t), file = path.join(f.project, 'plan/stage-manifest.json'), value = await readJson(file);
    if (mode === 'duplicate') value.stages.push(value.stages[0]);
    if (mode === 'missing-required') value.stages.shift();
    if (mode === 'missing-custom') value.stages.pop();
    if (mode === 'unsafe-id') value.stages.at(-1).id = '../outside';
    if (mode === 'foreign-task') value.taskId = 'another-task';
    if (mode === 'missing-manifest') await fs.unlink(file); else await atomicJson(file, value);
    const planFile = path.join(f.project, 'plan/production-plan.json'), before = await hashFile(planFile);
    await assert.rejects(runProductionHarness({ ...f, signal: new AbortController().signal,
      step: async () => assert.fail('No tool may start') }), /Cannot resume invalid production state/);
    assert.equal(await hashFile(planFile), before);
    await assert.rejects(fs.stat(path.join(f.root, 'production-state')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(f.project, 'plan/production-context.json')), { code: 'ENOENT' });
  });
}

for (const mode of ['pass', 'custom-evidence-gap', 'custom-manifest-gap', 'removed-stage']) {
  test('full harness checks custom stage requirements: ' + mode, async t => {
    const f = await fixture(t);
    const settings = { MODELING_ROUTING_ENABLED: '0', CODEX_CMD: process.execPath, CODEX_MAX_ATTEMPTS: '1' };
    const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
    Object.assign(process.env, settings);
    t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
    let authors = 0;
    const result = await runProductionHarness({ ...f, job: { ...f.job, runId: 'continued-run' }, unreal: 'fixture', signal: new AbortController().signal,
      step: async name => {
        if (name.startsWith('production-orchestrator')) {
          authors++;
          const production = await readProductionPlans(f.project, f.job);
          await fs.mkdir(path.join(f.project, 'package/Windows'), { recursive: true });
          await fs.writeFile(path.join(f.project, 'Game.uproject'), '{}');
          await fs.writeFile(path.join(f.project, 'scene-preview.png'), 'preview');
          await fs.writeFile(path.join(f.project, 'package/Windows/Game.exe'), 'executable');
          const { files } = await inspectProduction(f.project, production.stageIds);
          const identity = { taskId: f.job.taskId, workspaceId: f.job.workspaceId, runId: 'continued-run' };
          for (const [role, file] of Object.entries(files)) {
            if (!file.endsWith('.json')) continue;
            const report = role === 'stageManifest' ? { ...production.values['stage-manifest.json'], ...identity,
              stages: production.values['stage-manifest.json'].stages.map(row => ({ ...row, status: mode === 'custom-manifest-gap' && row.id === 'lighting' ? 'PROVISIONAL' : 'ACCEPTED' })) }
              : role === 'acceptanceReport' ? { protocol: 1, ...identity, status: 'ACCEPTED', passed: true,
                packagedGameStatus: 'PASS', gameplayStatus: 'PASS', visualStatus: 'PASS', criteria: [{ status: 'PASS' }] }
                : role.endsWith('-evidence') ? { status: 'PASS', criteria: [{ status: mode === 'custom-evidence-gap' && role === 'lighting-evidence' ? 'GAP' : 'PASS' }] }
                  : { status: 'ACCEPTED' };
            await atomicJson(file, report);
          }
          if (mode === 'removed-stage') for (const filename of names) {
            const file = path.join(f.project, 'plan', filename), value = await readJson(file);
            value.stages = value.stages.filter(row => row.id !== 'lighting'); await atomicJson(file, value);
          }
        }
        return { exitCode: 0, stdout: '', stderr: '', stopConfirmed: true };
      } });
    assert.equal(authors, 1);
    assert.equal(result.qualityAccepted, mode === 'pass');
    if (mode === 'custom-evidence-gap') assert.ok(result.delivery.issues.some(row => row.stage === 'stage-evidence:lighting'));
    if (mode === 'custom-manifest-gap') assert.ok(result.delivery.issues.some(row => row.stage === 'stage-manifest'));
    if (mode === 'removed-stage') assert.ok(result.delivery.issues.some(row => row.stage === 'production-plan'));
    assert.equal((await readJson(path.join(f.project, 'plan/production-context.json'))).stages.length, 15);
  });
}
