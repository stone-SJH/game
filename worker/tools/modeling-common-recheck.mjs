// Read-only final acceptance of retained outputs. Original task failures stay in the denominator.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicJson, hashFile, localPath, readJson, repositoryRoot, agentEnvironment } from '../agent/modeling-io.mjs';
import { createExecutionStore, fileEvidence, verifyEvidence } from '../agent/modeling-execution.mjs';
import { createModelingReviewer } from '../agent/modeling-review.mjs';
import { visualEvidence, visualReviewPrompt, visualRubric } from '../agent/modeling-rubric.mjs';
import { visualSchemaFor, reviewPasses } from '../agent/modeling-evaluation.mjs';
import { codexInvocation } from '../agent/production-harness.mjs';
import { blenderExecutable } from '../agent/modeling-capabilities.mjs';
import { modelingRuntimeIdentity } from '../agent/modeling-runtime-lock.mjs';
import { runCommand } from '../agent/process-runner.mjs';

export async function retainedFinals(project) {
  const specs=(await readJson(path.join(project,'plan/modeling-specs.json')))?.assets||[],assets=[];
  async function walk(directory,spec) {
    for(const entry of await fs.readdir(directory,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;})) {
      if(entry.isSymbolicLink())throw new Error('Retained output contains a link');
      if(!entry.isDirectory())continue;
      const child=path.join(directory,entry.name);
      if(!/^(?:blender_direct|reuse_blender|tripo_then_blender)-[1-9]\d*$/.test(entry.name)) { await walk(child,spec);continue; }
      const required=['source.blend','model.glb','asset-manifest.json'];
      if(!(await Promise.all(required.map(name=>fs.stat(path.join(child,name)).then(s=>s.isFile()).catch(error=>{if(error.code==='ENOENT')return false;throw error;})))).every(Boolean))continue;
      const files=[];
      async function collect(folder) {
        for(const item of await fs.readdir(folder,{withFileTypes:true})) {
          const relative=path.relative(project,path.join(folder,item.name)).replaceAll('\\','/');
          const file=await localPath(project,relative,{existing:true});
          if(item.isDirectory())await collect(file);
          else if(item.isFile())files.push({path:relative,sha256:await hashFile(file)});
        }
      }
      await collect(child);files.sort((a,b)=>a.path.localeCompare(b.path));
      assets.push({assetId:spec.assetId,spec,route:entry.name.replace(/-\d+$/,''),files,
        evidenceSource:'retained-unaccepted',attempt:entry.name});
    }
  }
  for(const spec of specs)await walk(await localPath(project,`art/models/${spec.assetId}`),spec);
  return assets.sort((a,b)=>a.files[0].path.localeCompare(b.files[0].path));
}

export async function recheckAccepted({benchmarkRoot,output,signal,stepOverride,evaluate}) {
  const benchmark=await readJson(path.join(benchmarkRoot,'benchmark-report.json'));
  if(!benchmark?.results?.length)throw new Error('A completed benchmark is required');
  await fs.mkdir(output); // Never reroll a completed or uncertain recheck.
  const invocation=codexInvocation([]),rows=[];
  const checker=path.join(repositoryRoot,'worker/tools/modeling-asset-check.py');
  await atomicJson(path.join(output,'identity.json'),{runtime:await modelingRuntimeIdentity(invocation,output),
    files:await fileEvidence(['modeling-asset-check.py','modeling_scene.py','modeling_quality.py','modeling_reference.py','modeling_traversal.py']
      .map(file=>path.join(repositoryRoot,'worker/tools',file)))});
  for(const result of benchmark.results) {
    const project=path.join(benchmarkRoot,result.id,'project');
    const assets=result.summary?.assets?.length?result.summary.assets:await retainedFinals(project);
    if(!assets.length) { rows.push({id:result.id,onlinePassed:result.passed,status:'NO_COMPLETE_OUTPUT',originalFailure:result.kind||result.error});continue; }
    for(const asset of assets) {
      const target=path.join(output,`${result.id}-${asset.assetId}${asset.attempt?'-'+asset.attempt:''}`);await fs.mkdir(target);
      await atomicJson(path.join(target,'input-manifest.json'),asset);
      const files=[];
      for(const file of asset.files) {
        const absolute=await localPath(project,file.path,{existing:true});
        if(await hashFile(absolute)!==file.sha256)throw new Error('Accepted evidence changed before recheck');files.push(absolute);
      }
      const spec=asset.spec;
      for(const reference of [...spec.referenceImages,...(spec.contract?.referenceMatches||[]).map(match=>match.mask)])
        files.push(await localPath(project,reference,{existing:true}));
      const frozen=await fileEvidence([...new Set(files)]);
      const directory=path.dirname(await localPath(project,asset.files.find(f=>f.path.endsWith('/source.blend')).path,{existing:true}));
      const specFile=path.join(target,'spec.json');await atomicJson(specFile,spec);await atomicJson(path.join(target,'rubric.json'),visualRubric(spec));
      const execution=createExecutionStore(path.join(target,'execution'),{signal});
      const step=stepOverride||async function(name,command,args,timeoutMs,cwd,accepts,options={}) {
        const value=await runCommand(command,args,{...options,cwd,timeoutMs,signal,env:agentEnvironment(options.env||process.env),
          stdoutFile:path.join(target,name+'.stdout.log'),stderrFile:path.join(target,name+'.stderr.log')});
        if(value.exitCode!==0||value.error||value.timedOut||value.canceled||!value.stopConfirmed)throw Object.assign(new Error(`Recheck ${name} failed`),{result:value});
        return value;
      };
      const row={id:result.id,assetId:asset.assetId,onlinePassed:result.passed,sourceRoute:asset.route,
        evidenceSource:asset.evidenceSource||'accepted-manifest',attempt:asset.attempt||null,originalFailure:result.kind||result.error||null};
      let fatal;
      try {
        if(spec.contract?.runtime.profile.startsWith('fbx')) {
          const required=path.relative(project,path.join(directory,'model.fbx')).replaceAll('\\','/');
          if(!asset.files.some(file=>file.path===required))throw Object.assign(new Error(`Required runtime export is absent from retained evidence: ${required}`),
            {kind:'ARTIFACT_GAP',gaps:[{id:'runtimeExport',status:'GAP',file:required}]});
        }
        const geometry=await execution.run({key:'technical',stage:'TECHNICAL',input:{spec},evidence:frozen,maxCalls:2,timeoutMs:300000,retry:()=>true},async({callId,timeoutMs})=>{
          const report=path.join(target,callId,'geometry-report.json');await fs.mkdir(path.dirname(report));
          await step(callId,blenderExecutable(),['--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',checker,'--',
            '--directory',directory,'--spec',specFile,'--report',report,'--workspace',project],timeoutMs,project);
          const value=await readJson(report);
          if(!value||value.assetId!==spec.assetId||typeof value.passed!=='boolean')throw new Error('Technical report is missing or invalid');
          if(value.sourceHash!==await hashFile(path.join(directory,'source.blend'))||value.exportHash!==await hashFile(path.join(directory,'model.glb')))throw new Error('Technical report identifies different files');
          return value;
        });
        row.technicalPassed=geometry.passed;
        if(!geometry.passed) {
          row.status='TECHNICAL_GAP';
          row.gaps=[...['source','export'].flatMap(component=>(geometry[component]?.gates||[])
            .filter(g=>g.status==='GAP').map(g=>({...g,component}))),
            ...(geometry.referenceMatches||[]).filter(match=>match.status==='GAP').map(match=>({...match,id:'referenceMatch'})),
            ...(geometry.missingRuntimeDependencies||[]).map(name=>({id:'runtimeDependency',status:'GAP',name}))];
        }
        else {
          const references=await Promise.all(spec.referenceImages.map(file=>localPath(project,file,{existing:true})));
          const targets=[...geometry.views,...geometry.motionViews||[]].map(v=>v.file);
          const images=[...references,...targets],evidence=visualEvidence(images,references.length);
          const reviewer=createModelingReviewer({execution,project:output,output:target,signal,step,invocation,evaluate});
          const review=await reviewer({name:'common-visual',key:'visual',schema:visualSchemaFor(spec,evidence),images,
            prompt:visualReviewPrompt({spec,evidence,metrics:geometry}),validate:value=>reviewPasses(value,spec,evidence)});
          row.status=reviewPasses(review,spec,evidence)?'PASS':'VISUAL_GAP';row.review=review;
        }
      } catch(error) {
        row.status=error.kind==='ARTIFACT_GAP'?'ARTIFACT_GAP':'INFRASTRUCTURE_ERROR';row.failure={kind:error.kind||'UNCATEGORIZED',message:error.message};
        if(error.kind==='ARTIFACT_GAP') {row.technicalPassed=false;row.gaps=error.gaps;}
        if(signal?.aborted||error.stopConfirmed===false||error.result?.stopConfirmed===false)fatal=error;
      }
      await verifyEvidence(frozen);row.inputFilesUnchanged=true;rows.push(row);
      await atomicJson(path.join(output,'report.json'),{registered:benchmark.results.length,rows,complete:false});
      if(fatal)throw fatal;
    }
  }
  const report={registered:benchmark.results.length,rows,complete:true,
    note:'This common checker covers accepted outputs and every complete retained final attempt. A PASS on retained output never changes the failed online task verdict. Missing or interrupted tasks remain in the original denominator; incomplete blockouts are not final assets.'};
  await atomicJson(path.join(output,'report.json'),report);return report;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  if(process.argv.length!==4)throw new Error('Usage: <completed-benchmark-root> <new-output>');
  const controller=new AbortController();process.on('SIGINT',()=>controller.abort());
  const report=await recheckAccepted({benchmarkRoot:path.resolve(process.argv[2]),output:path.resolve(process.argv[3]),signal:controller.signal});
  console.log(JSON.stringify(report));if(report.rows.some(r=>r.status!=='PASS'))process.exitCode=1;
}
