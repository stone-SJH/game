import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { defaultContract, preservesContract, modelViews } from '../agent/modeling-contract.mjs';
import { validateSpecs } from '../agent/modeling-evaluation.mjs';
import { createSkillPlan, validateSkillPlan, selectSkills, pinToolchain } from '../agent/modeling-skill-routing.mjs';
import { createModelingPipeline } from '../agent/modeling-pipeline.mjs';
import { createTripoProvider } from '../agent/providers/tripo.mjs';
import { atomicJson, hashFile, hashValue, readJson, recordAuthorRecipe } from '../agent/modeling-io.mjs';
import { serveBlender } from '../tools/blender-mcp-server.mjs';
import { validateUnrealModels } from '../agent/modeling-unreal.mjs';

const spec = { assetId:'meter', description:'Meter prop', prompt:'Meter prop', requirements:['One red meter prop'],
  referenceImages:[], maxTriangles:1000, requireRig:false, requireClosedMesh:true, contract:defaultContract() };
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'modeling-v2 '));
  // Use a checked, task-owned absolute directory for cleanup.
  assert.ok(root.startsWith(path.join(os.tmpdir(),'modeling-v2 ')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const project=path.join(root,'project'),output=path.join(root,'run');
  await fs.mkdir(project);await fs.mkdir(output);
  return {root,project,output};
}

test('v2 contracts preserve legacy plans and reject invalid dimensions, rig and LOD targets',()=>{
  assert.equal(validateSpecs({reason:'v2',assets:[spec]}).assets.length,1);
  const {contract,...old}=spec;
  assert.equal(validateSpecs({reason:'old',assets:[old]}).assets.length,1);
  for(const change of [
    {dimensions:{meters:[1,-1,1],toleranceMeters:.01}},
    {runtime:{...contract.runtime,lodTriangles:[2000]}},
    {runtime:{...contract.runtime,animations:['Walk']}},
    {pivot:{mode:'custom',meters:null,toleranceMeters:.01}},
  ])assert.throws(()=>validateSpecs({reason:'bad',assets:[{...spec,contract:{...contract,...change}}]}));
  assert.equal(preservesContract(spec,{...spec,contract:{...contract,budgets:{...contract.budgets,materials:20}}}),false);
  assert.equal(preservesContract(spec,{...spec,contract:Object.fromEntries(Object.entries(contract).reverse())}),true);
  assert.ok(modelViews(spec).includes('top'));
});

test('skill routing pins and copies only relevant resources; modified task helpers invalidate execution',async t=>{
  const f=await fixture(t);
  assert.deepEqual(selectSkills(spec).selected,['yahaha-blender-modeling']);
  const low={...spec,contract:defaultContract({styleProfile:'lowpoly'})};
  const plan=await createSkillPlan({...f,spec:low});
  assert.ok(plan.selected.includes('yahaha-blender-lowpoly'));
  await validateSkillPlan(f.project,plan);
  await fs.appendFile(path.join(f.project,plan.helperDirectories.find(d=>d.includes('yahaha-blender-lowpoly')),'yahaha_lpm.py'),'\n# altered');
  await assert.rejects(validateSkillPlan(f.project,plan),/changed/);
  await assert.rejects(createSkillPlan({...f,spec:low}),/modified/);
});

test('online preflight suppresses third-party routing and caches one balance request per pipeline',async t=>{
  const f=await fixture(t);let balances=0,builds=0;
  const pipeline=createModelingPipeline({...f,job:{taskId:'t',workspaceId:'w',runId:'r',modelingSpecs:[spec]},signal:new AbortController().signal,
    invocation:{args:[],command:process.execPath},step:async()=>{},probe:async()=>({blenderMcpAvailable:true,blenderVersion:'test'}),
    provider:{availability:async()=>({enabled:true}),balance:async()=>{balances++;return {status:'unavailable',reasonCode:'authentication'};},generate:async()=>{throw new Error('Must not submit');}},
    evaluate:async()=>{throw new Error('Force bounded conservative route');},
    build:async({directory})=>{builds++;for(const n of ['source.blend','model.glb','recipe.py','asset-manifest.json'])await fs.writeFile(path.join(f.project,directory,n),'fixture');
      await atomicJson(path.join(f.project,directory,'build-report.json'),{smallEditsOnly:true});},
    check:async()=>({passed:true,smallEditsOnly:true})});
  const first=await pipeline.prepare();assert.equal(first.assets[0].status,'DCC_READY');
  await pipeline.prepare();assert.equal(balances,1);assert.equal(builds,1);
  await atomicJson(path.join(f.project,'plan/modeling-request.json'),{reason:'Add observable detail',assets:[{...spec,requirements:[...spec.requirements,'A black dial is visible']}]});
  const revised=await pipeline.prepare();assert.equal(builds,2);assert.equal(revised.assets[0].spec.requirements.length,2);
  await atomicJson(path.join(f.project,'plan/modeling-request.json'),{reason:'looser',assets:[{...spec,contract:defaultContract({budgets:{materials:100,maxTextureSize:8192,textureBytes:999999999}})}]});
  await assert.rejects(pipeline.prepare(),/weaken/);
});

test('unknown provider region cannot poll a legacy task or submit a second generation',async t=>{
  const f=await fixture(t),keyFile=path.join(f.root,'key.txt');await fs.writeFile(keyFile,'fixture');
  const stateFile=path.join(f.root,'provider.json'),ledgerFile=path.join(f.root,'ledger.json');let calls=0;
  const abort=new AbortController();
  const args={project:f.project,directory:'generated',stateFile,ledgerFile,assetId:'a',prompt:'test',requirementsHash:'h',signal:abort.signal};
  const provider=createTripoProvider({keyFile,fetchImpl:async(url,opts)=>{calls++;if(opts.method==='POST')return new Response(JSON.stringify({code:0,data:{task_id:'one'}}));abort.abort();throw new Error('pause');}});
  await assert.rejects(provider.generate(args));
  const state=await readJson(stateFile);delete state.providerRegion;await atomicJson(stateFile,state);
  const count=calls;
  assert.equal((await provider.generate({...args,signal:new AbortController().signal})).reasonCode,'provider_region_unknown');assert.equal(calls,count);
});

test('checkpoint rejects workspace escapes, stale hashes and writes a distinct immutable copy',async t=>{
  const f=await fixture(t),source=path.join(f.project,'source.blend');await fs.writeFile(source,'blend fixture');
  const input=new PassThrough(),output=new PassThrough(),messages=[];
  output.on('data',chunk=>messages.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const server=serveBlender({workspace:f.project,blender:'unused',input,output});
  const send=(id,args)=>input.write(JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name:'blender_checkpoint',arguments:args}})+'\n');
  send(1,{source:'../source.blend',expectedHash:'a'.repeat(64),stage:'blockout'});
  send(2,{source:'source.blend',expectedHash:'a'.repeat(64),stage:'blockout'});
  const hash=await hashFile(source);send(3,{source:'source.blend',expectedHash:hash,stage:'blockout'});
  await server.finished();input.end();
  assert.ok(messages[0].result.isError);assert.ok(messages[1].result.isError);
  const info=JSON.parse(messages[2].result.content[0].text);
  assert.notEqual(info.file,'source.blend');assert.equal(await hashFile(path.join(f.project,info.file)),hash);
});

test('DCC_READY cannot become ENGINE_READY from missing or invented import evidence',async t=>{
  const f=await fixture(t);let steps=0;
  await assert.rejects(validateUnrealModels({...f,summary:{assets:[{assetId:'a',contract:{runtime:{engine:'unreal'}}}]},step:async()=>steps++}),/import mapping/);
  assert.equal(steps,0);
});

test('task toolchain survives resume and refuses a version switch before budgets can reset',async t=>{
  const f=await fixture(t),state=path.join(f.root,'state');
  await pinToolchain(state,'meter',{version:2,hash:'original'});
  await pinToolchain(state,'meter',{version:2,hash:'original'});
  await assert.rejects(pinToolchain(state,'meter',{version:2,hash:'changed'}),/toolchain changed/);
  assert.equal((await readJson(path.join(state,'toolchain-meter.json'))).hash,'original');
});

test('new run keeps the task contract when the global intake flag is disabled',async t=>{
  const f=await fixture(t),state=path.join(f.root,'modeling-state','tasks',hashValue({taskId:'same-task',workspaceId:'same-workspace'}));
  await atomicJson(path.join(state,'plan.json'),{reason:'Saved v2 task',assets:[spec],revisions:2});
  let observed;
  const pipeline=createModelingPipeline({...f,job:{taskId:'same-task',workspaceId:'same-workspace',runId:'next',modelingSpecs:[]},
    signal:new AbortController().signal,invocation:{args:[],command:process.execPath},step:async()=>{},
    probe:async()=>({blenderMcpAvailable:true,blenderVersion:'test'}),provider:{availability:async()=>({enabled:false})},
    evaluate:async()=>{throw new Error('Use local route');},check:async()=>({passed:true,smallEditsOnly:true}),
    build:async({directory,spec:current})=>{observed=current;for(const n of ['source.blend','model.glb','recipe.py','asset-manifest.json'])await fs.writeFile(path.join(f.project,directory,n),'fixture');
      await atomicJson(path.join(f.project,directory,'build-report.json'),{smallEditsOnly:true});}});
  await pipeline.prepare();
  assert.equal(observed.contract.version,2);assert.equal((await readJson(path.join(state,'plan.json'))).revisions,2);
  const newOutput=path.join(f.root,'new-run');await fs.mkdir(newOutput);
  const next=createModelingPipeline({...f,output:newOutput,job:{taskId:'new-task',workspaceId:'same-workspace',runId:'new',modelingSpecs:[]},
    signal:new AbortController().signal,probe:async()=>{throw new Error('No modeling required for new task');}});
  assert.equal((await next.prepare()).assets.length,0);
});

test('execution recipe retains actual script order and rejects modified execution history',async t=>{
  const f=await fixture(t);await fs.mkdir(path.join(f.project,'model'));
  await fs.writeFile(path.join(f.project,'model/source.blend'),'saved-scene');
  const calls=[];
  for(const [i,exitCode] of [1,0].entries()){
    const scriptFile=`step-${i}.py`;await fs.writeFile(path.join(f.project,scriptFile),`# actual invocation ${i}`);
    calls.push({tool:'blender_run_python',scriptFile,scriptHash:await hashFile(path.join(f.project,scriptFile)),exitCode});
  }
  const files=await recordAuthorRecipe(f.project,'model',{calls});
  assert.equal(files.length,3);assert.deepEqual((await readJson(path.join(f.project,files[0]))).steps.map(s=>s.exitCode),[1,0]);
  await fs.appendFile(path.join(f.project,'step-0.py'),'changed');
  await assert.rejects(recordAuthorRecipe(f.project,'model',{calls}),/script changed/);
});
