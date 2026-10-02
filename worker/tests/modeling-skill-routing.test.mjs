import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { defaultContract } from '../agent/modeling-contract.mjs';
import { atomicJson, hashFile } from '../agent/modeling-io.mjs';
import { createSkillPlan } from '../agent/modeling-skill-routing.mjs';

const spec = { assetId: 'prop', referenceImages: [], contract: defaultContract() };
const referenced = { ...spec, referenceImages: ['reference.png'] };
async function fixture(t, original = spec) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-plan-resume-'));
  assert.ok(project.startsWith(path.join(os.tmpdir(), 'skill-plan-resume-')));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const plan = await createSkillPlan({ spec: original, project });
  const file = path.join(project, 'tools/modeling-skills', plan.lockHash, 'skill-plan.json');
  return { project, plan, file, pinnedLockHash: plan.lockHash };
}

test('added references resume the original skill archive without reading current release skills or rewriting files', async t => {
  const original = { ...spec, contract: defaultContract({ styleProfile: 'lowpoly',
    runtime: { ...spec.contract.runtime, engine: 'unreal' } }) };
  const f = await fixture(t, original);
  const files = [f.file, ...f.plan.resources.map(row => path.join(f.project, 'tools/modeling-skills', f.plan.lockHash, row.path))];
  const before = await Promise.all(files.map(hashFile));
  const resumed = await createSkillPlan({ ...f, spec: { ...original, referenceImages: referenced.referenceImages },
    skillsRoot: path.join(f.project, 'unavailable-release'), feedback: 'Repair silhouette' });
  assert.deepEqual(resumed, { ...f.plan, repairDimensions: ['silhouette'] });
  assert.deepEqual(await Promise.all(files.map(hashFile)), before);
});

test('new assets with references still pin reference-fit and retain it across resume', async t => {
  const f = await fixture(t, referenced);
  assert.ok(f.plan.selected.includes('yahaha-blender-reference-fit'));
  assert.deepEqual(await createSkillPlan({ ...f, spec: { ...referenced, referenceImages: ['reference.png', 'side.png'] } }), f.plan);
  await assert.rejects(createSkillPlan({ ...f, spec }), { kind: 'INTEGRITY_ERROR' });
});

for (const mutation of ['missing', 'protocol', 'lock', 'resources', 'missing-resources', 'selected', 'entrypoints', 'helpers', 'stages', 'resource-file']) {
  test(`added references cannot hide a changed pinned ${mutation}`, async t => {
    const f = await fixture(t), plan = structuredClone(f.plan);
    if (mutation === 'missing') await fs.unlink(f.file);
    else if (mutation === 'resource-file') await fs.appendFile(path.join(f.project, plan.entrypoints[0]), '\nchanged');
    else {
      if (mutation === 'protocol') plan.protocol++;
      if (mutation === 'lock') plan.lockHash = '0'.repeat(64);
      if (mutation === 'resources') plan.resources.pop();
      if (mutation === 'missing-resources') delete plan.resources;
      if (mutation === 'selected') plan.selected.push('yahaha-blender-reference-fit');
      if (mutation === 'entrypoints') delete plan.entrypoints;
      if (mutation === 'helpers') plan.helperDirectories = [];
      if (mutation === 'stages') plan.stages = ['final'];
      await atomicJson(f.file, plan);
    }
    await assert.rejects(createSkillPlan({ ...f, spec: referenced }), { kind: 'INTEGRITY_ERROR' });
  });
}

test('reference-fit cannot be removed from metadata while its hashed resources remain', async t => {
  const f = await fixture(t, referenced);
  f.plan.selected = f.plan.selected.filter(name => name !== 'yahaha-blender-reference-fit');
  f.plan.entrypoints = f.plan.entrypoints.filter(file => !file.includes('/yahaha-blender-reference-fit/'));
  await atomicJson(f.file, f.plan);
  await assert.rejects(createSkillPlan({ ...f, spec: referenced }), { kind: 'INTEGRITY_ERROR' });
});

test('reference additions cannot silently reroute a changed style or engine', async t => {
  const f = await fixture(t);
  for (const contract of [defaultContract({ styleProfile: 'lowpoly' }),
    defaultContract({ runtime: { ...spec.contract.runtime, engine: 'unreal' } })]) {
    await assert.rejects(createSkillPlan({ ...f, spec: { ...referenced, contract } }), { kind: 'INTEGRITY_ERROR' });
  }
});
