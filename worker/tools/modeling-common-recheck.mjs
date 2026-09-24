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
    if(!result.summary?.assets?.length) { rows.push({id:result.id,onlinePassed:result.passed,status:'NO_ACCEPTED_OUTPUT',originalFailure:result.kind||result.error});continue; }
    const project=path.join(benchmarkRoot,result.id,'project');
    for(const asset of result.summary.assets) {
      const target=path.join(output,`${result.id}-${asset.assetId}`);await fs.mkdir(target);
      const files=[];
      for(const file of asset.files) {
        const absolute=await localPath(project,file.path,{existing:true});
        if(await hashFile(absolute)!==file.sha256)throw new Error('Accepted evidence changed before recheck');files.push(absolute);
      }
      const frozen=await fileEvidence(files),spec=asset.spec;
      const directory=path.dirname(await localPath(project,asset.files.find(f=>f.path.endsWith('/source.blend')).path,{existing:true}));
      const specFile=path.join(target,'spec.json');await atomicJson(specFile,spec);await atomicJson(path.join(target,'rubric.json'),visualRubric(spec));
      const execution=createExecutionStore(path.join(target,'execution'),{signal});
      const step=stepOverride||async function(name,command,args,timeoutMs,cwd,accepts,options={}) {
        const value=await runCommand(command,args,{...options,cwd,timeoutMs,signal,env:agentEnvironment(options.env||process.env),
          stdoutFile:path.join(target,name+'.stdout.log'),stderrFile:path.join(target,name+'.stderr.log')});
        if(value.exitCode!==0||value.error||value.timedOut||value.canceled||!value.stopConfirmed)throw Object.assign(new Error(`Recheck ${name} failed`),{result:value});
        return value;
      };
      const row={id:result.id,assetId:asset.assetId,onlinePassed:result.passed,sourceRoute:asset.route};
      let fatal;
      try {
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
        if(!geometry.passed) { row.status='TECHNICAL_GAP';row.gaps=['source','export'].flatMap(k=>geometry[k]?.gates?.filter(g=>g.status==='GAP')||[]); }
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
        row.status='INFRASTRUCTURE_ERROR';row.failure={kind:error.kind||'UNCATEGORIZED',message:error.message};
        if(signal?.aborted||error.stopConfirmed===false||error.result?.stopConfirmed===false)fatal=error;
      }
      await verifyEvidence(frozen);row.acceptedFilesUnchanged=true;rows.push(row);
      await atomicJson(path.join(output,'report.json'),{registered:benchmark.results.length,rows,complete:false});
      if(fatal)throw fatal;
    }
  }
  const report={registered:benchmark.results.length,rows,complete:true,
    note:'This common checker covers accepted outputs. Failed tasks without accepted output remain recorded; their retained intermediate attempts are not promoted to accepted assets. Original online verdicts are preserved.'};
  await atomicJson(path.join(output,'report.json'),report);return report;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  if(process.argv.length!==4)throw new Error('Usage: <completed-benchmark-root> <new-output>');
  const controller=new AbortController();process.on('SIGINT',()=>controller.abort());
  const report=await recheckAccepted({benchmarkRoot:path.resolve(process.argv[2]),output:path.resolve(process.argv[3]),signal:controller.signal});
  console.log(JSON.stringify(report));if(report.rows.some(r=>r.status!=='PASS'))process.exitCode=1;
}
