import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, hashValue, hashFile, localPath } from './modeling-io.mjs';
import { modelingRevisionSchema, validateSpecs, validateSchema } from './modeling-evaluation.mjs';
import { generatedContractSchema } from './modeling-contract.mjs';

const nonGeometryClasses = new Set(['SkyAtmosphere', 'DirectionalLight', 'SkyLight', 'PointLight', 'SpotLight', 'RectLight',
  'ExponentialHeightFog', 'PostProcessVolume', 'PlayerStart', 'CameraActor', 'CineCameraActor']);

function nonGeometrySystemActor(actor) {
  // A category or sourceRequired=false alone cannot exempt visible geometry.
  // Native camera proxies may exist, but each must be excluded from runtime rendering.
  return nonGeometryClasses.has(actor.actorClass) && actor.mesh === null && actor.renderMeshComponentCount === 0 &&
    Array.isArray(actor.editorMeshComponents) && actor.editorMeshComponents.every(component =>
      component?.editorOnly === true || component?.hiddenInGame === true || component?.visible === false);
}

export function coverageFirst(job = {}) {
  const text = [job.objective, job.payload?.followUpPrompt].filter(Boolean).join('\n');
  return /(?:先|优先)[^\n。]{0,180}(?:白模|placeholder|占位|全场)[^\n。]{0,180}(?:再|然后|细节|精修)|(?:first|before)[^.\n]{0,160}(?:placeholder|blockout|coverage)[^.\n]{0,160}(?:detail|refin)|(?:placeholder|blockout)[^.\n]{0,100}before[^.\n]{0,60}(?:detail|refin)/i.test(text);
}

export async function readSceneCoverage(project, job, iteration) {
  if (!coverageFirst(job)) return null;
  const directory = path.join(project, 'acceptance');
  const files = (await fs.readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; }))
    .filter(name => name === 'scene-coverage.json' || /^active-material-dependencies(?:-coverage\d+)?\.json$/.test(name));
  const records = [];
  for (const name of files) {
    const file = await localPath(project, `acceptance/${name}`, { existing: true });
    const record = await readJson(file, null, 16 * 1024 * 1024);
    if (record?.taskId === job.taskId && record.workspaceId === job.workspaceId && Array.isArray(record.actors))
      records.push({ record, file, modified: (await fs.stat(file)).mtimeMs });
  }
  records.sort((a, b) => b.modified - a.modified);
  const found = records[0];
  if (!found) return { required: true, status: 'GAP', complete: false, current: false, remaining: null, targets: [],
    fingerprint: null, reason: 'A complete saved-map instance inventory is required before detail refinement.' };
  const { record } = found;
  const targets = record.actors.filter(actor => !actor.hiddenInGame && (
    /temporary|placeholder|greybox|whitebox/i.test(actor.category || '') ||
    record.engineNativeProvisionalActors?.includes(actor.label) || record.missingOrDefaultMaterialActors?.includes(actor.label)))
    .map(actor => ({ label: actor.label, assetId: actor.assetId || `coverage-${hashValue(actor.label).slice(0, 12)}`, mesh: actor.mesh || null, category: actor.category || null }));
  const missing = record.missingOrDefaultMaterialActors || [];
  const current = record.runId === job.runId && record.iteration === iteration;
  const sourceProblems = [], hashes = new Map();
  for (const actor of record.actors.filter(actor => !actor.hiddenInGame && !nonGeometrySystemActor(actor) &&
    !['allowed-distant-silhouette', 'intentional-ember-fx'].includes(actor.category))) {
    try {
      if (!/\.blend$/i.test(actor.formalBlenderSource || '') || !actor.materials?.length || actor.materials.some(name => /defaultmaterial|worldgridmaterial/i.test(name))) throw new Error('Missing source/material');
      await localPath(project, actor.formalBlenderSource, { existing: true });
      const exported = actor.immutableFBX || actor.immutableExport;
      if (!/^[a-f0-9]{64}$/.test(exported?.sha256 || '')) throw new Error('Missing export hash');
      if (!hashes.has(exported.path)) hashes.set(exported.path, await hashFile(await localPath(project, exported.path, { existing: true })));
      if (hashes.get(exported.path) !== exported.sha256) throw new Error('Export hash changed');
    } catch { sourceProblems.push(actor.label); }
  }
  const complete = record.actors.length > 0 && targets.length === 0 && missing.length === 0 && sourceProblems.length === 0 && record.finalBlenderSourceCompliance === 'PASS';
  return { required: true, status: complete && current ? 'PASS' : 'GAP', complete, current, remaining: targets.length,
    sourceProblems,
    targets, missingMaterials: missing.length, fingerprint: hashValue({ targets: targets.map(x => x.label).sort(), missing: [...missing].sort(), sourceProblems: [...sourceProblems].sort(), formal: record.finalBlenderSourceCompliance }),
    evidence: path.relative(project, found.file).replaceAll('\\', '/'), sourceRunId: record.runId,
    reason: !current ? 'Retained inventory guides repairs; fresh current-run and iteration evidence is required.' : !complete
      ? 'Visible placeholders or missing formal source/material coverage remain. Finish coverage before refinement.' : 'Complete current scene coverage.' };
}

export function coverageInstructions(coverage) {
  if (!coverage) return '';
  return [
    'COVERAGE FIRST is a binding stage gate. Complete the geometry, UVs, baked materials and saved-map replacement of EVERY visible placeholder and temporary terrain before detail refinement.',
    `Host coverage status: ${JSON.stringify(coverage)}. Read the referenced full inventory and plan/scene-coverage-status.json.`,
    'Write acceptance/scene-coverage.json for this task/workspace/run/iteration with actors covering EVERY saved-map instance, label, assetId, mesh, category, hiddenInGame, formalBlenderSource, immutableFBX and materials; include engineNativeProvisionalActors, missingOrDefaultMaterialActors, finalBlenderSourceCompliance (PASS only with complete verified source/material mapping). A material binding alone is not formal source compliance.',
    'For native lights, atmosphere/fog, post-process volumes, player starts and cameras, record actorClass, mesh:null, renderMeshComponentCount and editorMeshComponents with editorOnly/hiddenInGame/visible flags from the saved map. Blender source is inapplicable only when no runtime render mesh exists and every editor proxy is excluded from runtime rendering. Keep these actors in the inventory; category or sourceRequired alone cannot exempt geometry.',
    'For temporary terrain beyond a frozen core envelope, add a separate asset contract with its own measured placement, seams, collision and budgets. Preserve the core contract. Do not repeatedly refine the core in place of replacing the remaining terrain.',
    'During coverage, reuse unaffected assets. Produce replacement assets and update every affected instance, then recheck visibility, sources, seams and traversal. Keep the playable checkpoint and report remaining gaps; do not spend this phase on unrelated detail, lighting polish or another unchanged package.',
  ].join('\n');
}

export function coverageStalled(rounds) {
  const recent = rounds.slice(-3).map(row => row.coverage);
  return recent.length === 3 && recent.every(row => row?.current && row.status === 'GAP' && row.fingerprint && row.fingerprint === recent[0].fingerprint);
}

export function coverageImproved(previous, current) {
  return current?.current && (current.status === 'PASS' && previous?.status !== 'PASS' ||
    Number.isInteger(current.remaining) && (!Number.isInteger(previous?.remaining) || current.remaining < previous.remaining));
}

export async function extendCoveragePlan({ current, coverage, review, iteration, timeoutMs }) {
  const missing = [...new Set((coverage?.targets || []).map(row => row.assetId))].filter(id => !current.assets.some(asset => asset.assetId === id));
  if (!missing.length) return current;
  const result = await review('modeling-coverage-plan', modelingRevisionSchema, [
    'Close the scene coverage planning gap. Return the full asset plan, copying EVERY existing asset and contract exactly. Add a separate v2 asset for each missing ID. Do not expand the frozen core or alter existing technical targets.',
    'Describe complete visible-instance replacement, source/UV/baked-material provenance, measured layout, seam blending and appropriate collision verification for the additions. Unmeasured dimensions stay null; document design choices, not invented measurements. New tolerances must be positive. Preserve the original fidelity and source restrictions. Keep prompts within 1024 characters.',
    `Existing plan: ${JSON.stringify({ reason: current.reason, assets: current.assets })}`,
    `Required additional IDs: ${JSON.stringify(missing)}. Saved-map coverage evidence: ${JSON.stringify(coverage)}`,
  ].join('\n'), [], { key: `modeling-coverage-plan:iteration-${iteration}`, maxCalls: 2, timeoutMs,
    validate: value => {
      validateSpecs(value);
      for (const asset of current.assets) {
        const retained = value.assets.find(row => row.assetId === asset.assetId);
        if (!retained || hashValue(retained) !== hashValue(asset)) throw new Error('Coverage planning must preserve every existing asset and frozen contract exactly.');
      }
      if (value.assets.length !== current.assets.length + missing.length || missing.some(id => !value.assets.some(asset => asset.assetId === id)))
        throw new Error('Coverage planning must add every missing coverage asset without unrelated additions.');
      for (const asset of value.assets.filter(row => missing.includes(row.assetId))) validateSchema(asset.contract, generatedContractSchema);
    } });
  return { ...result, revisions: (current.revisions || 0) + 1 };
}
