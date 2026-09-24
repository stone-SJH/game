import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { recheckAccepted, retainedFinals } from '../tools/modeling-common-recheck.mjs';
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
  assert.equal(report.rows[0].status,'VISUAL_GAP');assert.equal(report.rows[0].onlinePassed,true);assert.equal(report.rows[0].inputFilesUnchanged,true);
  assert.equal(report.rows[1].status,'NO_COMPLETE_OUTPUT');assert.equal(report.rows[1].originalFailure,'AUTHOR_PROCESS_ERROR');
  await assert.rejects(recheckAccepted({benchmarkRoot,output}),/EEXIST/);
});

test('retained discovery inspects complete final attempts without promoting blockouts or rewriting results',async t=>{
  const project=await fs.mkdtemp(path.join(os.tmpdir(),'retained-finals-'));t.after(()=>fs.rm(project,{recursive:true,force:true}));
  const spec={assetId:'fixture',requirements:['Blue cabinet'],referenceImages:[],contract:defaultContract()};
  await atomicJson(path.join(project,'plan/modeling-specs.json'),{assets:[spec]});
  const base=path.join(project,'art/models/fixture/frozen');
  for(const attempt of ['blender_direct-1','blender_direct-2','blender_direct-2/blockout']) {
    const directory=path.join(base,attempt);await fs.mkdir(directory,{recursive:true});
    for(const name of attempt==='blender_direct-1'?['source.blend','model.glb','asset-manifest.json']:['source.blend','asset-manifest.json'])await fs.writeFile(path.join(directory,name),'retained');
  }
  await fs.mkdir(path.join(base,'blender_direct-1/textures'));
  await fs.writeFile(path.join(base,'blender_direct-1/textures/color.png'),'texture dependency');
  const rows=await retainedFinals(project);assert.equal(rows.length,1);assert.equal(rows[0].attempt,'blender_direct-1');
  assert.equal(rows[0].evidenceSource,'retained-unaccepted');assert.deepEqual(rows[0].spec,spec);
  assert.equal(rows[0].files.length,4);assert.ok(rows[0].files.every(f=>f.sha256.length===64));
  assert.ok(rows[0].files.some(f=>f.path.endsWith('/textures/color.png')));
});

async function failedFinal(t,contract=defaultContract()) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'retained-gap-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const project=path.join(root,'benchmark/fixture-1/project'),directory=path.join(project,'art/models/fixture/frozen/blender_direct-1');
  const spec={assetId:'fixture',requirements:['Blue cabinet'],referenceImages:[],contract};
  await atomicJson(path.join(project,'plan/modeling-specs.json'),{assets:[spec]});await fs.mkdir(directory,{recursive:true});
  for(const name of ['source.blend','model.glb','asset-manifest.json'])await fs.writeFile(path.join(directory,name),'retained '+name);
  await atomicJson(path.join(root,'benchmark/benchmark-report.json'),{results:[{id:'fixture-1',passed:false,kind:'AUTHOR_PROCESS_ERROR'}]});
  return {benchmarkRoot:path.join(root,'benchmark'),output:path.join(root,'result'),directory};
}

test('missing required FBX is an artifact gap without infrastructure retries or promotion',async t=>{
  const options=await failedFinal(t,defaultContract({runtime:{...defaultContract().runtime,engine:'unreal',profile:'fbx-static'}}));
  const report=await recheckAccepted({...options,stepOverride:()=>assert.fail('Missing export must not invoke Blender'),
    evaluate:()=>assert.fail('Missing export must not invoke a reviewer')});
  const row=report.rows[0];assert.equal(report.registered,1);assert.equal(row.status,'ARTIFACT_GAP');
  assert.equal(row.evidenceSource,'retained-unaccepted');assert.equal(row.onlinePassed,false);assert.equal(row.inputFilesUnchanged,true);
  assert.equal(row.originalFailure,'AUTHOR_PROCESS_ERROR');assert.equal(row.technicalPassed,false);assert.equal(row.gaps[0].id,'runtimeExport');
});

test('common recheck retains reference and runtime dependency quality gaps without retry',async t=>{
  const options=await failedFinal(t);let calls=0;
  const report=await recheckAccepted({...options,stepOverride:async(name,command,args)=>{
    calls++;await atomicJson(args[args.indexOf('--report')+1],{assetId:'fixture',passed:false,
      sourceHash:await hashFile(path.join(options.directory,'source.blend')),exportHash:await hashFile(path.join(options.directory,'model.glb')),
      source:{gates:[{id:'uv',status:'GAP'}]},export:{gates:[]},
      referenceMatches:[{image:'reference.png',status:'GAP',iou:0.2},{image:'other.png',status:'PASS',iou:1}],
      missingRuntimeDependencies:['paint.png']});
  },evaluate:()=>assert.fail('A technical gap must not invoke visual review')});
  assert.equal(calls,1);const row=report.rows[0];assert.equal(row.status,'TECHNICAL_GAP');assert.equal(row.onlinePassed,false);
  assert.deepEqual(row.gaps.map(g=>g.id),['uv','referenceMatch','runtimeDependency']);assert.equal(row.gaps[0].component,'source');
  assert.equal(row.gaps[1].iou,0.2);assert.equal(row.gaps[2].name,'paint.png');assert.equal(row.inputFilesUnchanged,true);
});
