import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, readJson, localPath, hashFile, repositoryRoot, agentEnvironment } from './modeling-io.mjs';
import { modelingInvocationArgs, visualSchemaFor, reviewPasses } from './modeling-evaluation.mjs';

export async function validateUnrealModels({ summary, project, output, unreal, projectFile, step, signal, invocation, attempt }) {
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
      dccDimensions: geometry.export.dimensions, dccCollisionCount: geometry.source.gates.find(g=>g.id==='collision')?.actual?.length || 0 });
  }
  const directory = path.join(output, `modeling-unreal-${attempt}`);
  await fs.mkdir(directory,{recursive:true});
  const requestFile=path.join(directory,'request.json'), reportFile=path.join(directory,'report.json'), wrapper=path.join(directory,'inspect.py');
  await atomicJson(requestFile,request);
  const tool=path.join(repositoryRoot,'worker/tools/modeling-unreal-check.py');
  // JSON string literals are valid Python path literals; values remain data, not shell text.
  await fs.writeFile(wrapper,`import runpy\ncheck = runpy.run_path(${JSON.stringify(tool)})\ncheck['validate'](${JSON.stringify(requestFile)}, ${JSON.stringify(reportFile)})\n`);
  await fs.rm(reportFile,{force:true});
  await step(`modeling-unreal-${attempt}`,unreal,[projectFile,'-unattended','-nosplash','-nop4','-nosound','-AllowCommandletRendering','-run=pythonscript',`-script=${wrapper}`],300000,project,undefined,{env:agentEnvironment()});
  signal.throwIfAborted();
  const report=await readJson(reportFile);
  if (!report || report.requestHash !== await hashFile(requestFile) || !report.passed || report.assets.length!==assets.length) throw new Error(`Unreal modeling gates failed: ${JSON.stringify(report?.assets || 'missing evidence').slice(0,5000)}`);
  for (const asset of assets) {
    const row=report.assets.find(r=>r.assetId===asset.assetId && r.requirementsHash===asset.requirementsHash);
    if (!row?.passed || !row.views?.length) throw new Error('Missing current engine asset evidence.');
    const images=[];
    for (const view of row.views) {
      const file=await localPath(directory,path.relative(directory,view.file),{existing:true});
      if (await hashFile(file)!==view.sha256 || (await fs.stat(file)).size>10*1024*1024) throw new Error('Invalid UE screenshot evidence.');
      images.push(file);
    }
    const schemaFile=path.join(directory,`${asset.assetId}-schema.json`), responseFile=path.join(directory,`${asset.assetId}-visual.json`);
    await atomicJson(schemaFile,visualSchemaFor(asset.spec));
    await fs.rm(responseFile,{force:true});
    const prompt=`Independently inspect actual Unreal map captures. Return exactly one criterion per original requirement. Assess silhouette, orientation, material fidelity, scale readability and missing parts. A black/empty capture is GAP. Geometry alone is not visual PASS. Specification: ${JSON.stringify(asset.spec)}\nEngine metrics: ${JSON.stringify(row)}\nCompare original requirements verbatim. smallEditsOnly means local repair is sufficient.`;
    await step(`modeling-engine-visual-${attempt}-${asset.assetId}`,invocation.command,modelingInvocationArgs(invocation,project,schemaFile,responseFile,images),120000,project,undefined,{input:prompt,env:agentEnvironment()});
    if (!reviewPasses(await readJson(responseFile),asset.spec)) throw new Error(`Unreal visual quality gap: ${asset.assetId}`);
  }
  const result={protocol:2,status:'ENGINE_READY',reportFile,assets:assets.map(a=>({assetId:a.assetId,requirementsHash:a.requirementsHash,status:'ENGINE_READY'}))};
  await atomicJson(path.join(directory,'engine-ready.json'),result);
  return result;
}
