import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, hashFile, hashValue, localPath, readJson, repositoryRoot } from './modeling-io.mjs';

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
    if (entry.isSymbolicLink()) throw new Error('Skill resources cannot be symbolic links.');
    if (entry.name === '__pycache__') continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await resourceFiles(file));
    else result.push(file);
  }
  return result.sort();
}

export async function createSkillPlan({ spec, project, feedback, skillsRoot = path.join(repositoryRoot, 'skills') }) {
  const { selected, repairDimensions } = selectSkills(spec, feedback);
  const upstream = await readJson(path.join(skillsRoot, 'modeling-upstream-lock.json'));
  if (!upstream?.files?.length) throw new Error('Missing modeling upstream lock.');
  for (const entry of upstream.files.filter(f => selected.some(name => f.localPath.startsWith(`${name}/`)))) {
    if (await hashFile(await localPath(skillsRoot, entry.localPath, { existing: true })) !== entry.sha256) throw new Error(`Pinned upstream changed: ${entry.localPath}`);
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
    if (await hashFile(destination) !== resource.sha256) throw new Error('Task skill resource was modified.');
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
    if (await hashFile(await localPath(project, `tools/modeling-skills/${plan.lockHash}/${resource.path}`, { existing: true })) !== resource.sha256) throw new Error('Pinned task skill changed.');
  }
}

export async function pinToolchain(stateRoot, assetId, toolchain) {
  await fs.mkdir(stateRoot, { recursive: true });
  const file = path.join(stateRoot, `toolchain-${assetId}.json`);
  try { await fs.writeFile(file, JSON.stringify(toolchain), { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (hashValue(await readJson(file)) !== hashValue(toolchain)) {
    throw Object.assign(new Error('Active modeling task toolchain changed. Restore its pinned release or stop with evidence; budgets cannot restart under another toolchain.'), { hardFailure: true });
  }
}

export async function modelingToolHashes() {
  const files = ['agent/production-harness.mjs', 'agent/process-runner.mjs', 'agent/iteration-monitor.mjs',
    'agent/asset-catalog.mjs', 'agent/providers/tripo.mjs', 'tools/blender-mcp-server.mjs'];
  for (const directory of ['agent', 'tools']) {
    for (const entry of await fs.readdir(path.join(repositoryRoot, 'worker', directory))) {
      if (/^modeling[-_].*\.(mjs|py)$/.test(entry)) files.push(`${directory}/${entry}`);
    }
  }
  return Promise.all(files.sort().map(async file => ({ file, sha256: await hashFile(path.join(repositoryRoot, 'worker', file)) })));
}
