import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runRegisteredBatch, verifyBatch, verifyPrerequisite, waitForPrerequisite } from '../tools/modeling-batch-runner.mjs';
import { atomicJson, hashFile, hashValue, readJson } from '../agent/modeling-io.mjs';
const execute=promisify(execFile);

async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'modeling-batch-runner-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const repo=path.join(root,'repo'),script=path.join(repo,'worker/tools/modeling-v2-probe.mjs');
  await fs.mkdir(path.dirname(script),{recursive:true});
  await fs.writeFile(script,`import fs from 'node:fs/promises';import path from 'node:path';
const args=process.argv.slice(2),out=args[args.indexOf('--out')+1];
await fs.mkdir(out); // Fails if the runner incorrectly precreates the task output.
await fs.writeFile(path.join(out,'benchmark-report.json'),JSON.stringify({results:[{passed:false}]}));
process.exitCode=1;`);
  for(const args of [['init'],['add','worker'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','Fixture']])await execute('git',args,{cwd:repo,windowsHide:true});
  const {stdout}=await execute('git',['rev-parse','HEAD'],{cwd:repo,windowsHide:true});
  const input=path.join(root,'input');await fs.writeFile(input,'frozen');
  const spec={assetId:'fixture'},tasks=[1,2].map(repeat=>({id:`baseline/fixture-${repeat}`,spec,specHash:hashValue(spec),command:process.execPath,
    args:[script,'--case','fixture','--repeat','1','--out',path.join(root,`task-${repeat}`)]}));
  const plan={protocol:1,execution:{mode:'DIAGNOSTIC_R4_FAILED',repositories:[{path:repo,commit:stdout.trim()}]},tasks,
    inputs:[{file:input,sha256:await hashFile(input)}],settings:{providerEnabled:false,runtime:{files:[]},policy:{buildMs:1800000,cleanupMs:300000,reviewMs:120000}}};
  return {root,plan,logDirectory:path.join(root,'logs'),input};
}

test('real Node tasks receive the script argument, create their own outputs and retain failed samples',async t=>{
  const f=await fixture(t);const report=await runRegisteredBatch(f);
  assert.equal(report.finished,2);assert.equal(report.registered,2);
  assert.ok(report.tasks.every(r=>r.state==='FINISHED'&&r.passed===false&&r.exitCode===1&&r.stopConfirmed));
  assert.equal((await readJson(path.join(f.logDirectory,'report.json'))).tasks.length,2);
  await assert.rejects(runRegisteredBatch(f),/Output already exists/);
});

test('unknown stop is durably fenced and never launches the next sample',async t=>{
  const f=await fixture(t);let launches=0;
  await assert.rejects(runRegisteredBatch({...f,launch:async(command,args)=>{
    launches++;const report=await readJson(path.join(f.logDirectory,'report.json'));
    assert.equal(report.tasks[0].state,'STARTED');assert.equal(args[0],f.plan.tasks[0].args[0]);
    assert.equal(command,process.execPath);return {exitCode:null,stopConfirmed:false};
  }}),/FENCED/);
  assert.equal(launches,1);const report=await readJson(path.join(f.logDirectory,'report.json'));
  assert.equal(report.tasks[0].state,'FENCED');assert.equal(report.finished,0);
});

test('changed frozen inputs stop before another launch; malformed script and duplicate output are rejected',async t=>{
  const f=await fixture(t);let launches=0;
  await assert.rejects(runRegisteredBatch({...f,launch:async(command,args)=>{
    launches++;const out=args[args.indexOf('--out')+1];await fs.mkdir(out);
    await fs.writeFile(path.join(out,'benchmark-report.json'),JSON.stringify({results:[{passed:false}]}));
    await fs.writeFile(f.input,'changed');return {exitCode:1,stopConfirmed:true};
  }}),/Frozen input changed/);assert.equal(launches,1);
  const bad=structuredClone(f.plan);bad.tasks[0].args.shift();await assert.rejects(verifyBatch(bad),/Probe script/);
  const duplicate=structuredClone(f.plan);duplicate.tasks[1]=duplicate.tasks[0];
  // Use new output names so registration validation reaches the duplicate entry.
  duplicate.tasks[0].args[duplicate.tasks[0].args.indexOf('--out')+1]=path.join(f.root,'unstarted');
  await assert.rejects(verifyBatch(duplicate),/Duplicate task/);
});

test('host exit does not clear an unfinished nested author',async t=>{
  const f=await fixture(t);let launches=0;
  await assert.rejects(runRegisteredBatch({...f,launch:async(command,args)=>{
    launches++;const out=args[args.indexOf('--out')+1];
    await atomicJson(path.join(out,'benchmark-report.json'),{results:[{passed:false}]});
    await atomicJson(path.join(out,'fixture-1/modeling-state/key/execution.json'),{groups:{author:{calls:[{callId:'author-1',status:'STARTED'}]}}});
    return {exitCode:1,stopConfirmed:true};
  }}),/FENCED/);assert.equal(launches,1);
  const report=await readJson(path.join(f.logDirectory,'report.json'));
  assert.equal(report.tasks[0].unfinishedCalls[0].callId,'author-1');assert.equal(report.finished,0);
});

test('comparison waits for every candidate result and rejects nested work left running',async t=>{
  const f=await fixture(t),completionReport=path.join(f.root,'candidate-complete.json'),out=path.join(f.root,'candidate/fixture-1');
  const prerequisite={completionReport,candidateRegistered:1,candidateOutput:path.join(f.root,'candidate')};
  await assert.rejects(verifyPrerequisite(prerequisite),/not complete/);
  const completion={finishedAt:new Date().toISOString(),finished:1,tasks:[{out,state:'FINISHED',stopConfirmed:true}]};
  await atomicJson(completionReport,completion);await assert.rejects(verifyPrerequisite(prerequisite),/no terminal/);
  await atomicJson(path.join(out,'benchmark-report.json'),{results:[{passed:false}]});await verifyPrerequisite(prerequisite);
  await atomicJson(path.join(out,'fixture-1/modeling-state/key/execution.json'),{groups:{review:{calls:[{status:'STARTED',callId:'review-1'}]}}});
  await assert.rejects(verifyPrerequisite(prerequisite),/unconfirmed nested/);
});

test('incremental report existence does not launch comparisons before confirmed host exit',async t=>{
  const f=await fixture(t),completionReport=path.join(f.root,'candidate-progress.json'),out=path.join(f.root,'candidate/fixture-1');
  const prerequisite={completionReport,candidateRegistered:1,candidateOutput:path.join(f.root,'candidate')};
  const progress={finished:0,tasks:[{out,state:'STARTED'}]};
  await atomicJson(completionReport,progress);
  await atomicJson(path.join(out,'benchmark-report.json'),{results:[{passed:false}]});
  await assert.rejects(verifyPrerequisite(prerequisite),/not complete/);
  let polls=0;
  await waitForPrerequisite(prerequisite,{pause:async()=>{
    polls++;await atomicJson(completionReport,{finished:1,finishedAt:new Date().toISOString(),tasks:[{out,state:'FINISHED',stopConfirmed:true}]});
  }});
  assert.equal(polls,1);
  await atomicJson(completionReport,{tasks:[{out,state:'FENCED'}]});
  await assert.rejects(waitForPrerequisite(prerequisite,{pause:()=>assert.fail('A fenced report must not keep waiting')}),/stopped/);
});
