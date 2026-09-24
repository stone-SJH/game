import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { auditModelingBatch } from '../tools/modeling-r6-audit.mjs';
import { atomicJson, hashFile, hashValue } from '../agent/modeling-io.mjs';

async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'modeling-r6-audit-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const source=path.join(root,'input.blend');await fs.writeFile(source,'frozen source');
  const spec={assetId:'fixture',requirements:['Blue cabinet']};
  const task=(category,repeat)=>({id:`candidate/${category}-${repeat}`,variant:'candidate',category,repeat,spec,specHash:hashValue(spec)});
  const manifest={inputs:[{file:source,sha256:await hashFile(source)}],tasks:[task('reuse',1),task('organic',1),task('organic',2)]};
  const caseRoot=task=>path.join(root,`${task.category}-${task.repeat}`,'fixture-1');
  async function start(task) { const project=path.join(caseRoot(task),'project');await atomicJson(path.join(project,'plan/modeling-specs.json'),{assets:[spec]});return project; }
  return {root,manifest,spec,caseRoot,start,audit:()=>auditModelingBatch({manifest,variant:'candidate',outputRoot:root})};
}

test('audit preserves registered denominator and separates quality gaps from service retries',async t=>{
  const f=await fixture(t),task=f.manifest.tasks[1];await f.start(task);
  await atomicJson(path.join(f.caseRoot(task),'modeling-state/key/state.json'),{attempts:{blender_direct:2},failures:[
    {kind:'AUTHOR_PROCESS_ERROR',attemptId:'a1',phase:'AUTHORING'},
    {kind:'VISUAL_GAP',attemptId:'a2',phase:'VISUAL_PENDING',message:'Missing rings'}]});
  await atomicJson(path.join(f.caseRoot(task),'modeling-state/key/execution.json'),{groups:{review:{stage:'review',calls:[
    {callId:'1',status:'FAILED',error:{kind:'REVIEW_PROCESS_ERROR',stopConfirmed:true}},
    {callId:'2',status:'STARTED'}]}}});
  const log=path.join(f.caseRoot(task),'run/call.stdout.log');await fs.mkdir(path.dirname(log));
  await fs.writeFile(log,JSON.stringify({type:'error',message:'unexpected status 503'})+'\n'+JSON.stringify({type:'turn.completed',usage:{input_tokens:100,output_tokens:20}}));
  let report=await f.audit();assert.equal(report.registered,3);assert.equal(report.finished,0);
  const row=report.rows[1];assert.equal(row.status,'IN_PROGRESS');assert.equal(row.authorAttempts,2);
  assert.equal(row.qualityGaps.length,1);assert.equal(row.calls.total,2);assert.equal(row.calls.inProgress.length,1);
  assert.deepEqual(row.serviceEvidence.httpStatusCounts,{'503':1});assert.equal(row.completedCallUsage.length,1);
  await atomicJson(path.join(f.root,'organic-1/benchmark-report.json'),{results:[{passed:false,kind:'REVIEW_PROCESS_ERROR',durationMs:50,error:'service failed'}]});
  report=await f.audit();assert.equal(report.finished,1);assert.equal(report.categories.organic.registered,2);
  assert.equal(report.categories.organic.failed,1);assert.equal(report.rows[1].terminalFailure.kind,'REVIEW_PROCESS_ERROR');
  assert.equal(report.rows[2].status,'NOT_STARTED');assert.equal(report.integrityPassed,true);
  await atomicJson(path.join(f.root,'organic-2/runner-interruption.json'),{kind:'BATCH_INTERRUPTED',reason:'Stopped by host fencing'});
  report=await f.audit();assert.equal(report.finished,2);assert.equal(report.categories.organic.failed,2);
  assert.equal(report.rows[2].status,'INTERRUPTED');assert.equal(report.rows[2].terminalFailure.kind,'BATCH_INTERRUPTED');
});

test('reuse requires actual route and immutable source, spec and accepted files',async t=>{
  const f=await fixture(t),task=f.manifest.tasks[0],project=await f.start(task);
  await fs.copyFile(f.manifest.inputs[0].file,path.join(project,'existing.blend'));
  await fs.writeFile(path.join(project,'model.glb'),'accepted model');
  const benchmark={results:[{passed:true,durationMs:99,summary:{assets:[{assetId:'fixture',route:'reuse_blender',files:[{path:'model.glb',sha256:await hashFile(path.join(project,'model.glb'))}]}]}}]};
  const reportFile=path.join(f.root,'reuse-1/benchmark-report.json');await atomicJson(reportFile,benchmark);
  let report=await f.audit();assert.equal(report.categories.reuse.reusedAndPassed,1);assert.equal(report.integrityPassed,true);
  benchmark.results[0].summary.assets[0].route='blender_direct';await atomicJson(reportFile,benchmark);
  report=await f.audit();assert.equal(report.categories.reuse.passed,1);assert.equal(report.categories.reuse.reusedAndPassed,0);
  await fs.writeFile(path.join(project,'existing.blend'),'changed');
  await fs.unlink(path.join(project,'model.glb'));
  await atomicJson(path.join(project,'plan/modeling-specs.json'),{assets:[{...f.spec,requirements:[]}]});
  report=await f.audit();assert.equal(report.integrityPassed,false);assert.equal(report.rows[0].sourceUnchanged,false);
  assert.equal(report.rows[0].specMatches,false);assert.equal(report.rows[0].assets[0].changedFiles.length,1);
  assert.equal(report.categories.reuse.passed,1); // Preserve the original online verdict even when evidence integrity fails.
});

test('empty accepted summary cannot satisfy reuse and duplicate registrations are rejected',async t=>{
  const f=await fixture(t),task=f.manifest.tasks[0],project=await f.start(task);
  await fs.copyFile(f.manifest.inputs[0].file,path.join(project,'existing.blend'));
  await atomicJson(path.join(f.root,'reuse-1/benchmark-report.json'),{results:[{passed:true,summary:{assets:[]}}]});
  const report=await f.audit();assert.equal(report.integrityPassed,false);assert.equal(report.categories.reuse.reusedAndPassed,0);
  f.manifest.tasks.push(task);await assert.rejects(f.audit(),/Duplicate registered task/);
});
