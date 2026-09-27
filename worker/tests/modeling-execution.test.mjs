import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createExecutionStore, fileEvidence, modelingFailure } from '../agent/modeling-execution.mjs';
import { atomicJson, hashValue } from '../agent/modeling-io.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modeling-execution-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const options = { key: 'visual/asset-1', stage: 'REVIEW', timeoutMs: 100, maxCalls: 3, retry: () => true };

test('reserved call after crash fences recovery, without reusing its id or budget', async t => {
  const root = await fixture(t); let invoked = 0;
  await assert.rejects(createExecutionStore(root).run({ ...options, onReserved: () => { throw new Error('crash'); } }, () => invoked++), /crash/);
  const resumed = createExecutionStore(root);
  await assert.rejects(resumed.run(options, () => invoked++), error => error.kind === 'STOP_UNCONFIRMED');
  assert.equal(invoked, 0);
  assert.equal((await resumed.snapshot()).nextCall, 2);
});

test('retry errors and exhaustion survive restart and retain each call', async t => {
  const root = await fixture(t); let count = 0;
  const invoke = () => { count++; throw modelingFailure('REVIEW_SCHEMA_INVALID', 'response.criteria is missing'); };
  await assert.rejects(createExecutionStore(root).run(options, invoke), error => error.kind === 'VALIDATION_INFRASTRUCTURE_EXHAUSTED');
  await assert.rejects(createExecutionStore(root).run(options, invoke), error => error.kind === 'VALIDATION_INFRASTRUCTURE_EXHAUSTED');
  const state = await createExecutionStore(root).snapshot();
  assert.equal(count, 3); assert.equal(state.nextCall, 4);
  assert.equal(Object.values(state.groups)[0].calls.length, 3);
});

test('successful result resumes without invoking tools, but changed evidence is rejected', async t => {
  const root = await fixture(t), asset = path.join(root, 'model.glb');
  await fs.writeFile(asset, 'original');
  const request = { ...options, evidence: await fileEvidence([asset]) }; let count = 0;
  const invoke = () => { count++; return { criteria: ['PASS'] }; };
  await createExecutionStore(root).run(request, invoke);
  assert.deepEqual(await createExecutionStore(root).run(request, invoke), { criteria: ['PASS'] });
  assert.equal(count, 1);
  await fs.writeFile(asset, 'changed');
  await assert.rejects(createExecutionStore(root).run(request, invoke), error => error.kind === 'INTEGRITY_ERROR');
});

test('elapsed stage deadline does not reset on restart and changed limits are rejected', async t => {
  const root = await fixture(t); let tick = 0, count = 0;
  await assert.rejects(createExecutionStore(root, { now: () => tick }).run(options, () => {
    count++; tick = 301; throw new Error('service error');
  }), error => error.kind === 'VALIDATION_INFRASTRUCTURE_EXHAUSTED');
  await assert.rejects(createExecutionStore(root, { now: () => tick }).run(options, () => count++), /exhausted/);
  await assert.rejects(createExecutionStore(root).run({ ...options, maxCalls: 4 }, () => count++), /limits changed/);
  assert.equal(count, 1);
});

test('cancellation and unconfirmed stop never retry', async t => {
  for (const mode of ['cancel', 'unknown-stop']) {
    const root = path.join(await fixture(t), mode), controller = new AbortController(); let count = 0;
    await assert.rejects(createExecutionStore(root, { signal: controller.signal }).run(options, () => {
      count++;
      if (mode === 'cancel') controller.abort(new Error('operator canceled'));
      throw Object.assign(new Error(mode), mode === 'unknown-stop' ? { stopConfirmed: false } : {});
    }));
    assert.equal(count, 1);
  }
});

test('resuming a confirmed canceled author consumes its old attempt without replaying it', async t => {
  const root=await fixture(t),controller=new AbortController();let calls=0;
  const request={key:'author/attempt-1',stage:'AUTHOR',timeoutMs:10000};
  await assert.rejects(createExecutionStore(root,{signal:controller.signal}).run(request,()=>{
    calls++;controller.abort(new Error('pause'));
    throw Object.assign(new Error('stopped'),{result:{canceled:true,stopConfirmed:true,exitCode:1}});
  }));
  await assert.rejects(createExecutionStore(root,{signal:new AbortController().signal}).run(request,()=>calls++),
    error=>error.kind==='AUTHOR_INTERRUPTED'&&!error.hardFailure&&error.stopConfirmed);
  assert.equal(calls,1);assert.equal((await createExecutionStore(root).snapshot()).nextCall,2);
});

test('resumed validation retains the old deadline and counts the canceled call', async t => {
  const root=await fixture(t),controller=new AbortController();let calls=0,tick=0;
  const request={...options,timeoutMs:1000};
  await assert.rejects(createExecutionStore(root,{signal:controller.signal,now:()=>tick}).run(request,()=>{
    calls++;tick=500;controller.abort(new Error('pause'));
    throw Object.assign(new Error('stopped'),{result:{canceled:true,stopConfirmed:true,exitCode:1}});
  }));
  const first=Object.values((await createExecutionStore(root).snapshot()).groups)[0];
  const result=await createExecutionStore(root,{signal:new AbortController().signal,now:()=>tick}).run(request,()=>{calls++;return 'valid';});
  const resumed=Object.values((await createExecutionStore(root).snapshot()).groups)[0];
  assert.equal(result,'valid');assert.equal(calls,2);assert.equal(resumed.calls.length,2);assert.equal(resumed.deadlineAt,first.deadlineAt);
  assert.equal(resumed.cancellationResumes[0].consumedCalls,1);
});

test('multiple image-bearing results stay resumable without growing the execution index past 2 MiB',async t=>{
  const root=await fixture(t),value={image:'a'.repeat(1200000)};let calls=0;
  for(let i=1;i<=3;i++)assert.deepEqual(await createExecutionStore(root).run({key:`preview-${i}`,stage:'PREVIEW',timeoutMs:10000},()=>{calls++;return value;}),value);
  assert.ok((await fs.stat(path.join(root,'execution.json'))).size<10000);
  assert.deepEqual(await createExecutionStore(root).run({key:'preview-1',stage:'PREVIEW',timeoutMs:10000},()=>calls++),value);
  assert.equal(calls,3);const state=await createExecutionStore(root).snapshot();assert.equal(state.protocol,3);assert.equal(state.nextCall,4);
  const group=Object.values(state.groups)[0];await fs.appendFile(path.join(root,group.resultEvidence.path),' ');
  await assert.rejects(createExecutionStore(root).run({key:'preview-1',stage:'PREVIEW',timeoutMs:10000},()=>calls++),error=>error.kind==='INTEGRITY_ERROR');
  assert.equal(calls,3);
});

test('oversized legacy v2 index migrates results without resetting calls, deadlines or failure fencing',async t=>{
  const root=await fixture(t),key='legacy-preview',inputHash=hashValue({input:{},evidence:[]});
  const legacy={protocol:2,nextCall:8,groups:{[hashValue(key)]:{key,stage:'PREVIEW',identity:{},inputHash,evidence:[],
    limits:{maxCalls:1,timeoutMs:10000,totalMs:10000},startedAt:0,deadlineAt:10000,completed:true,result:{image:'x'.repeat(2200000)},
    calls:[{callId:'preview-7',status:'COMPLETED',stopConfirmed:true}]}}};
  await atomicJson(path.join(root,'execution.json'),legacy);
  const store=createExecutionStore(root,{now:()=>5000});await store.assertSettled();
  let invoked=0;assert.equal((await store.run({key,stage:'PREVIEW',timeoutMs:10000},()=>invoked++)).image.length,2200000);
  await store.run({key:'next',stage:'REVIEW',timeoutMs:10000},()=>++invoked);
  const state=await store.snapshot();assert.equal(state.protocol,3);assert.equal(state.groups[hashValue(key)].deadlineAt,10000);
  assert.equal(state.groups[hashValue(key)].calls[0].callId,'preview-7');assert.equal(state.nextCall,9);assert.equal(invoked,1);
  assert.ok((await fs.stat(path.join(root,'execution.json'))).size<10000);
});
