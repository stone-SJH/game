import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicJson, hashFile, readJson } from '../agent/modeling-io.mjs';
import { recheckRegisteredBatch, waitForModelingBatch } from '../tools/modeling-common-recheck-batch.mjs';

test('common batch keeps interrupted and failed slots and never promotes retained PASS',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'common-batch-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const checker=path.join(root,'checker'),interruption=path.join(root,'interruption.json');
  await fs.writeFile(checker,'frozen checker');await atomicJson(interruption,{reason:'Host interrupted registered slot'});
  const plan={protocol:1,checkerEvidence:[{file:checker,sha256:await hashFile(checker)}],tasks:[
    {id:'candidate/lowpoly-1',benchmarkRoot:path.join(root,'interrupted'),interruptionEvidence:{file:interruption,sha256:await hashFile(interruption)}},
    {id:'baseline/modular-1',benchmarkRoot:path.join(root,'failed')}]};
  await atomicJson(path.join(root,'failed/benchmark-report.json'),{results:[{passed:false,kind:'AUTHOR_TIMEOUT'}]});
  let calls=0;
  const report=await recheckRegisteredBatch({plan,output:path.join(root,'report'),recheck:async()=>{
    calls++;return {rows:[{status:'PASS',onlinePassed:false,evidenceSource:'retained-unaccepted'}]};
  }});
  assert.equal(calls,1);assert.equal(report.registered,2);assert.equal(report.rows[0].status,'INTERRUPTED');
  assert.equal(report.rows[1].onlinePassed,false);assert.equal(report.rows[1].results[0].status,'PASS');
  await assert.rejects(recheckRegisteredBatch({plan,output:path.join(root,'report')}),/EEXIST/);
});

test('post-processing waits for complete settlement and stops without replay on uncertain recheck',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'common-fence-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const predecessor=path.join(root,'predecessor.json');let polls=0;
  await atomicJson(predecessor,{registered:1,tasks:[{state:'STARTED'}]});
  await waitForModelingBatch(predecessor,{pause:async()=>{
    polls++;await atomicJson(predecessor,{registered:1,finished:1,finishedAt:'done',tasks:[{state:'FINISHED',stopConfirmed:true,unfinishedCalls:[]}]});
  }});assert.equal(polls,1);
  await atomicJson(predecessor,{tasks:[{state:'FENCED'}]});
  await assert.rejects(waitForModelingBatch(predecessor),/settlement/);
  const checker=path.join(root,'checker');await fs.writeFile(checker,'frozen');
  const plan={protocol:1,checkerEvidence:[{file:checker,sha256:await hashFile(checker)}],tasks:[1,2].map(i=>({id:`candidate/rig-${i}`,benchmarkRoot:path.join(root,'slot-'+i)}))};
  for(const task of plan.tasks)await atomicJson(path.join(task.benchmarkRoot,'benchmark-report.json'),{results:[{passed:true}]});
  let calls=0;
  await assert.rejects(recheckRegisteredBatch({plan,output:path.join(root,'report'),recheck:async()=>{
    calls++;throw Object.assign(new Error('Unconfirmed stop'),{stopConfirmed:false});
  }}),/Unconfirmed stop/);
  assert.equal(calls,1);assert.equal((await readJson(path.join(root,'report/report.json'))).rows[0].status,'STOPPED');
});
