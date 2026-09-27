import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSingleStageAuthor } from '../tools/modeling-legacy-author.mjs';
import { defaultContract } from '../agent/modeling-contract.mjs';
import { atomicJson, hashFile } from '../agent/modeling-io.mjs';

test('single-stage comparison preserves the complete spec, clips the original deadline and never replays completed authors',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'modeling-single-stage-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const project=path.join(root,'project'),output=path.join(root,'run');await fs.mkdir(project);await fs.mkdir(output);await fs.mkdir(path.join(project,'asset'));
  const spec={assetId:'fixture',description:'Complete target',prompt:'A rig',requirements:['Bound red mesh'],referenceImages:[],requireRig:true,requireClosedMesh:true,maxTriangles:100,
    contract:defaultContract({assetClass:'skeletal-character',runtime:{engine:'none',profile:'fbx-skeletal',collision:'none',lodTriangles:[],sockets:[],animations:['Wave'],lightmapUV:false}})};
  const context={spec,directory:'asset',receiptFile:path.join(output,'receipt.json'),attemptId:'fixture-1',deadlineAt:Date.now()+60000,decision:{route:'blender_direct'}};let calls=0;
  const author=createSingleStageAuthor({project,output,signal:new AbortController().signal,invocation:{command:process.execPath,args:[]},
    step:async(name,command,args,timeoutMs,cwd,accepts,{input})=>{
      calls++;assert.ok(timeoutMs<=60000);assert.ok(input.includes(JSON.stringify(spec)));assert.match(input,/asset-manifest.json/);assert.match(input,/model.fbx/);
      for(const file of ['source.blend','model.glb','model.fbx','recipe.py','asset-manifest.json','build-report.json'])await fs.writeFile(path.join(project,'asset',file),'fixture');
      await atomicJson(context.receiptFile,{calls:[{tool:'blender_run_python',exitCode:0,stopConfirmed:true,scriptFile:'asset/recipe.py',scriptHash:await hashFile(path.join(project,'asset/recipe.py'))}]});
    }});
  await author(context);await author(context);assert.equal(calls,1);assert.ok(context.stageArtifacts.includes('asset/execution-recipe.json'));
  await assert.rejects(author({...context,spec:{...spec,contract:defaultContract()}}),/inputs or limits changed/);
  assert.equal(spec.contract.runtime.animations[0],'Wave');
});
