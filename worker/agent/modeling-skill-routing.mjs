import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, hashFile, hashValue, localPath, readJson, repositoryRoot } from './modeling-io.mjs';
import { modelingFailure, verifyEvidence } from './modeling-execution.mjs';

export function selectSkills(spec, feedback) {
  const selected = ['yahaha-blender-modeling'];
  if (spec.referenceImages.length) selected.push('yahaha-blender-reference-fit');
  if (spec.contract?.styleProfile === 'lowpoly') selected.push('yahaha-blender-lowpoly');
  if (spec.contract?.runtime.engine === 'unreal') selected.push('yahaha-blender-unreal-handoff');
  return { selected, repairDimensions: [...new Set((JSON.stringify(feedback || '').match(/silhouette|dimension|topology|UV|material|rig|export/gi) || []).map(s => s.toLowerCase()))] };
}

async function resourceFiles(directory) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw modelingFailure('INTEGRITY_ERROR', 'Skill resources cannot be symbolic links.');
    if (entry.name === '__pycache__') continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await resourceFiles(file));
    else result.push(file);
  }
  return result.sort();
}

export async function createSkillPlan({ spec, project, feedback, skillsRoot = path.join(repositoryRoot, 'skills'), pinnedLockHash }) {
  const { selected, repairDimensions } = selectSkills(spec, feedback);
  if (pinnedLockHash) {
    if (!/^[a-f0-9]{64}$/.test(pinnedLockHash)) throw modelingFailure('INTEGRITY_ERROR', 'Invalid pinned skill identity.');
    const root = `tools/modeling-skills/${pinnedLockHash}`;
    const plan = await readJson(await localPath(project, `${root}/skill-plan.json`));
    if (!plan || plan.protocol !== 2 || plan.lockHash !== pinnedLockHash || hashValue(plan.resources) !== pinnedLockHash ||
        hashValue(plan.selected) !== hashValue(selected) ||
        hashValue(plan.entrypoints) !== hashValue(selected.map(name => `${root}/${name}/SKILL.md`)) ||
        hashValue(plan.helperDirectories) !== hashValue(selected.filter(name => ['yahaha-blender-modeling', 'yahaha-blender-lowpoly'].includes(name)).map(name => `${root}/${name}/scripts`)) ||
        hashValue(plan.stages) !== hashValue(['blockout', 'final'])) {
      throw modelingFailure('INTEGRITY_ERROR', 'Pinned skill plan changed or is missing.');
    }
    await validateSkillPlan(project, plan);
    return { ...plan, repairDimensions };
  }
  const upstream = await readJson(path.join(skillsRoot, 'modeling-upstream-lock.json'));
  if (!upstream?.files?.length) throw new Error('Missing modeling upstream lock.');
  for (const entry of upstream.files.filter(f => selected.some(name => f.localPath.startsWith(`${name}/`)))) {
    await verifyEvidence([{ file: await localPath(skillsRoot, entry.localPath), sha256: entry.sha256 }]);
  }
  const resources = [];
  for (const name of selected) for (const file of await resourceFiles(path.join(skillsRoot, name))) {
    resources.push({ path: path.relative(skillsRoot, file).replaceAll('\\', '/'), sha256: await hashFile(file) });
  }
  const lockHash = hashValue(resources);
  const root = `tools/modeling-skills/${lockHash}`;
  for (const resource of resources) {
    const destination = await localPath(project, `${root}/${resource.path}`);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    try {
      await fs.copyFile(path.join(skillsRoot, resource.path), destination, fs.constants.COPYFILE_EXCL);
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await verifyEvidence([{ file: destination, sha256: resource.sha256 }]);
  }
  const plan = { protocol: 2, lockHash, selected, repairDimensions, resources,
    entrypoints: selected.map(name => `${root}/${name}/SKILL.md`),
    helperDirectories: selected.filter(name => ['yahaha-blender-modeling', 'yahaha-blender-lowpoly'].includes(name)).map(name => `${root}/${name}/scripts`),
    stages: ['blockout', 'final'], upstreamLockHash: hashValue(upstream) };
  await atomicJson(await localPath(project, `${root}/skill-plan.json`), plan);
  return plan;
}

export async function validateSkillPlan(project, plan) {
  for (const resource of plan.resources) {
    await verifyEvidence([{ file: await localPath(project, `tools/modeling-skills/${plan.lockHash}/${resource.path}`), sha256: resource.sha256 }]);
  }
}

export async function pinToolchain(stateRoot, assetId, toolchain) {
  await fs.mkdir(stateRoot, { recursive: true });
  const file = path.join(stateRoot, `toolchain-${assetId}.json`);
  try { await fs.writeFile(file, JSON.stringify(toolchain), { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (hashValue(await readJson(file)) !== hashValue(toolchain)) {
    throw Object.assign(new Error('Active modeling task toolchain changed. Restore its pinned release or stop with evidence; budgets cannot restart under another toolchain.'), { hardFailure: true, kind: 'TOOLCHAIN_CHANGED' });
  }
}

export async function modelingToolHashes() {
  const files = ['agent/production-harness.mjs', 'agent/process-runner.mjs', 'agent/iteration-monitor.mjs',
    'agent/iteration-quality.mjs', 'agent/production-iterations.mjs', 'agent/quality-review.mjs', 'agent/stage-failure.mjs', 'agent/artifact-publication.mjs',
    'agent/asset-catalog.mjs', 'agent/providers/tripo.mjs', 'tools/blender-mcp-server.mjs'];
  for (const directory of ['agent', 'tools']) {
    for (const entry of await fs.readdir(path.join(repositoryRoot, 'worker', directory))) {
      if (/^modeling[-_].*\.(mjs|py)$/.test(entry)) files.push(`${directory}/${entry}`);
    }
  }
  return Promise.all(files.sort().map(async file => ({ file, sha256: await hashFile(path.join(repositoryRoot, 'worker', file)) })));
}
