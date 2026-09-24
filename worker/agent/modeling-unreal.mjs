import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, readJson, localPath, hashFile, hashValue, repositoryRoot, agentEnvironment } from './modeling-io.mjs';
import { visualSchemaFor, reviewPasses } from './modeling-evaluation.mjs';
import { createExecutionStore, executionPolicy, fileEvidence, verifyEvidence, modelingFailure } from './modeling-execution.mjs';
import { createModelingReviewer } from './modeling-review.mjs';

export async function validateUnrealModels({ summary, project, output, unreal, projectFile, step, signal, invocation, attempt, job = {}, evaluate }) {
  const assets = summary?.assets?.filter(a => a.contract?.runtime.engine === 'unreal') || [];
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
  for (const asset of assets) {
    const row=report.assets.find(r=>r.assetId===asset.assetId && r.requirementsHash===asset.requirementsHash);
    if (!row?.passed || !row.views?.length) throw new Error('Missing current engine asset evidence.');
    const images=[];
    for (const view of row.views) {
      const file=await localPath(directory,path.relative(directory,view.file),{existing:true});
      if (await hashFile(file)!==view.sha256 || (await fs.stat(file)).size>10*1024*1024) throw new Error('Invalid UE screenshot evidence.');
      images.push(file);
    }
    const prompt=`Independently inspect actual Unreal map captures. Return exactly one criterion per original requirement. Assess silhouette, orientation, material fidelity, scale readability and missing parts. A black/empty capture is GAP. Geometry alone is not visual PASS. Specification: ${JSON.stringify(asset.spec)}\nEngine metrics: ${JSON.stringify(row)}\nCompare original requirements verbatim. smallEditsOnly means local repair is sufficient.`;
    const result = await review({ name: 'modeling-engine-visual', schema: visualSchemaFor(asset.spec), prompt, images,
      key: `engine-visual:${evidenceKey}:${asset.assetId}`, identity: { assetId: asset.assetId }, validate: value => reviewPasses(value, asset.spec) });
    await atomicJson(path.join(directory,`${asset.assetId}-visual.json`), result);
    if (!reviewPasses(result,asset.spec)) throw Object.assign(new Error(`Unreal visual quality gap: ${asset.assetId}`), { kind: 'VISUAL_GAP' });
  }
  const result={protocol:2,status:'ENGINE_READY',reportFile,assets:assets.map(a=>({assetId:a.assetId,requirementsHash:a.requirementsHash,status:'ENGINE_READY'}))};
  await verifyEvidence(evidence);
  await atomicJson(path.join(directory,'engine-ready.json'),result);
  return result;
}
