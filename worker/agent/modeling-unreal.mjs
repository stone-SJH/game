import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, readJson, localPath, hashFile, hashValue, repositoryRoot, agentEnvironment } from './modeling-io.mjs';
import { visualSchemaFor, reviewPasses } from './modeling-evaluation.mjs';
import { createExecutionStore, executionPolicy, fileEvidence, verifyEvidence, modelingFailure } from './modeling-execution.mjs';
import { createModelingReviewer } from './modeling-review.mjs';
import { visualEvidence, visualReviewPrompt } from './modeling-rubric.mjs';
import { modelingRuntimeIdentity } from './modeling-runtime-lock.mjs';
import { pinToolchain, modelingToolHashes } from './modeling-skill-routing.mjs';
import { assetQuality } from './iteration-quality.mjs';

export async function validateUnrealModels({ summary, project, output, unreal, projectFile, step, signal, invocation, attempt, job = {}, evaluate, allowProvisional = false }) {
  const assets = summary?.assets?.filter(a => a.usable !== false && a.contract?.runtime.engine === 'unreal') || [];
  if (!assets.length) return { status: 'NOT_APPLICABLE', assets: [] };
  const entries = await readJson(await localPath(project, 'plan/modeling-engine-imports.json'));
  if (entries?.protocol !== 2 || !Array.isArray(entries.assets)) throw new Error('Missing v2 modeling engine import mapping.');
  const request = { protocol: 2, assets: [] };
  for (const asset of assets) {
    const found = entries.assets.filter(e => e.assetId === asset.assetId);
    if (found.length !== 1 || !/^\/Game\/[A-Za-z0-9_/.]+$/.test(found[0].packagePath) || !/^\/Game\/[A-Za-z0-9_/]+$/.test(found[0].mapPath)) throw new Error('Invalid engine asset mapping.');
    const source = asset.files.find(f => f.path.endsWith(asset.contract.runtime.profile === 'glb-static' ? '/model.glb' : '/model.fbx'));
    if (!source || await hashFile(await localPath(project,source.path,{existing:true})) !== source.sha256) throw new Error('Engine source export changed.');
    const geometryFile = asset.files.find(f => f.path.endsWith('/geometry-report.json'));
    if (!geometryFile) throw new Error('Missing accepted geometry report.');
    const geometry = await readJson(await localPath(project, geometryFile.path, {existing:true}));
    request.assets.push({ spec: asset.spec, import: found[0], sourceHash: source.sha256, requirementsHash: asset.requirementsHash,
      dccDimensions: geometry.export.dimensions, dccCollisionCount: geometry.source.gates.find(g=>g.id==='collision')?.actual?.length || 0,
      dccTraversal: geometry.source.gates.find(g=>g.id==='traversal')?.actual || null });
  }
  const execution = createExecutionStore(path.join(path.dirname(project), 'modeling-state', 'engine', hashValue({ taskId: job.taskId || null, project })),
    { signal, deadlineAt: job.deadlineAt });
  await execution.assertSettled();
  const policy = executionPolicy(invocation);
  await pinToolchain(path.join(path.dirname(project), 'modeling-state', 'engine-policy'), hashValue({ taskId: job.taskId || null, project }), {
    policy, runtime: await modelingRuntimeIdentity(invocation, project), harnessHashes: await modelingToolHashes(), unrealHash: await hashFile(unreal),
  });
  // All project content dependencies are immutable during host inspection. This includes materials
  // and textures referenced by the imported mesh, not merely the top-level uasset and umap.
  const engineFiles = [projectFile];
  async function contentFiles(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      await localPath(project, path.relative(project, file), { existing: true });
      if (entry.isDirectory()) await contentFiles(file); else engineFiles.push(file);
    }
  }
  await contentFiles(path.join(path.dirname(projectFile), 'Content'));
  const evidence = await fileEvidence(engineFiles.sort());
  const evidenceKey = hashValue({ request, evidence });
  const inspected = await execution.run({ key: `engine-technical:${evidenceKey}`, stage: 'TECHNICAL', input: { request, policy }, evidence,
    maxCalls: policy.technicalCalls, timeoutMs: policy.technicalMs, retry: () => true }, async ({ callId, timeoutMs }) => {
    const directory = path.join(output, `modeling-unreal-${attempt}-${callId}`);
    await fs.mkdir(directory,{recursive:true});
    const requestFile=path.join(directory,'request.json'), reportFile=path.join(directory,'report.json'), wrapper=path.join(directory,'inspect.py');
    await atomicJson(requestFile,request);
    const tool=path.join(repositoryRoot,'worker/tools/modeling-unreal-check.py');
    await fs.writeFile(wrapper,`import runpy\ncheck = runpy.run_path(${JSON.stringify(tool)})\ncheck['validate'](${JSON.stringify(requestFile)}, ${JSON.stringify(reportFile)})\n`);
    await step(`modeling-unreal-${attempt}-${callId}`,unreal,[projectFile,'-unattended','-nosplash','-nop4','-nosound','-AllowCommandletRendering','-run=pythonscript',`-script=${wrapper}`],timeoutMs,project,undefined,{env:agentEnvironment()});
    const report=await readJson(reportFile);
    if (!report || report.requestHash !== await hashFile(requestFile) || typeof report.passed !== 'boolean' || report.assets?.length !== assets.length) {
      throw modelingFailure('TECHNICAL_RUNNER_ERROR', 'Unreal inspection did not return a current technical report.');
    }
    const files = [requestFile, reportFile];
    for (const row of report.assets) for (const view of row.views || []) files.push(await localPath(directory, path.relative(directory, view.file), { existing: true }));
    return { directory, reportFile, requestFile, report, evidence: await fileEvidence(files) };
  });
  const { directory, reportFile, report } = inspected;
  await verifyEvidence(inspected.evidence);
  signal.throwIfAborted();
  if (!report.passed) throw Object.assign(new Error(`Unreal modeling gates failed: ${JSON.stringify(report.assets).slice(0,5000)}`), { kind: 'TECHNICAL_GAP' });
  const review = createModelingReviewer({ execution, project, output, signal, step, invocation, evaluate });
  const qualities = [];
  for (const asset of assets) {
    const row=report.assets.find(r=>r.assetId===asset.assetId && r.requirementsHash===asset.requirementsHash);
    if (!row?.passed || !row.views?.length) throw new Error('Missing current engine asset evidence.');
    const images=[];
    for (const file of asset.spec.referenceImages || []) images.push(await localPath(project, file, { existing: true }));
    for (const view of row.views) {
      const file=await localPath(directory,path.relative(directory,view.file),{existing:true});
      if (await hashFile(file)!==view.sha256 || (await fs.stat(file)).size>10*1024*1024) throw new Error('Invalid UE screenshot evidence.');
      images.push(file);
    }
    const visual = visualEvidence(images, asset.spec.referenceImages?.length || 0);
    const prompt = visualReviewPrompt({ spec: asset.spec, evidence: visual, metrics: row, phase: 'unreal-capture' });
    const result = await review({ name: 'modeling-engine-visual', schema: visualSchemaFor(asset.spec, visual), prompt, images,
      key: `engine-visual:${evidenceKey}:${asset.assetId}`, identity: { assetId: asset.assetId }, validate: value => reviewPasses(value, asset.spec, visual) });
    await atomicJson(path.join(directory,`${asset.assetId}-visual.json`), result);
    const passed = reviewPasses(result,asset.spec,visual);
    qualities.push({ assetId: asset.assetId, ...assetQuality(result, passed), reportFile: path.join(directory,`${asset.assetId}-visual.json`) });
    if (!passed && !allowProvisional) throw Object.assign(new Error(`Unreal visual quality gap: ${asset.assetId}`), { kind: 'VISUAL_GAP' });
  }
  const result={protocol:2,status:qualities.every(row => row.accepted) ? 'ENGINE_READY' : 'ENGINE_PROVISIONAL',reportFile,
    score: Math.round(qualities.reduce((n, row) => n + row.score, 0) / qualities.length),
    assets:assets.map(a=>({assetId:a.assetId,requirementsHash:a.requirementsHash,status:qualities.find(row => row.assetId === a.assetId).accepted ? 'ENGINE_READY' : 'ENGINE_PROVISIONAL', quality:qualities.find(row => row.assetId === a.assetId)}))};
  await verifyEvidence(evidence);
  await atomicJson(path.join(directory,'engine-ready.json'),result);
  return result;
}
