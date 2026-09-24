import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { recheckAccepted } from '../tools/modeling-common-recheck.mjs';
import { atomicJson, hashFile } from '../agent/modeling-io.mjs';
import { defaultContract } from '../agent/modeling-contract.mjs';

test('common recheck preserves failed task denominator and never resamples a valid GAP',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'common-recheck-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const benchmarkRoot=path.join(root,'benchmark'),output=path.join(root,'result'),directory=path.join(benchmarkRoot,'fixture-1/project/art');
  await fs.mkdir(directory,{recursive:true});const files=[];
  for(const name of ['source.blend','model.glb']) {const file=path.join(directory,name);await fs.writeFile(file,name);files.push({path:'art/'+name,sha256:await hashFile(file)});}
  const spec={assetId:'fixture',requirements:['The cabinet is blue.'],referenceImages:[],contract:defaultContract()};
  await atomicJson(path.join(benchmarkRoot,'benchmark-report.json'),{results:[{id:'fixture-1',passed:true,summary:{assets:[{assetId:'fixture',route:'reuse_blender',spec,files}]}},
    {id:'fixture-2',passed:false,kind:'AUTHOR_PROCESS_ERROR'}]});
  let technicalCalls=0,reviews=0;
  const report=await recheckAccepted({benchmarkRoot,output,signal:new AbortController().signal,
    stepOverride:async(name,command,args)=>{
      technicalCalls++;const reportFile=args[args.indexOf('--report')+1],image=path.join(path.dirname(reportFile),'front.png');await fs.writeFile(image,'fake view for injected reviewer');
      await atomicJson(reportFile,{assetId:spec.assetId,passed:true,sourceHash:files[0].sha256,exportHash:files[1].sha256,views:[{file:image}],motionViews:[]});
    },evaluate:async()=>{reviews++;return {smallEditsOnly:true,repairInstructions:'Change red paint to blue.',criteria:[{criterion:spec.requirements[0],status:'GAP',evidence:'The cabinet is red.',views:['image-1']}]};}});
  assert.equal(technicalCalls,1);assert.equal(reviews,1);assert.equal(report.registered,2);
  assert.equal(report.rows[0].status,'VISUAL_GAP');assert.equal(report.rows[0].onlinePassed,true);assert.equal(report.rows[0].acceptedFilesUnchanged,true);
  assert.equal(report.rows[1].status,'NO_ACCEPTED_OUTPUT');assert.equal(report.rows[1].originalFailure,'AUTHOR_PROCESS_ERROR');
  await assert.rejects(recheckAccepted({benchmarkRoot,output}),/EEXIST/);
});
