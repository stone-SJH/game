// Serial, immutable post-processing of the registered modeling slots. Never launches authors.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicJson, hashValue, localPath, readJson } from '../agent/modeling-io.mjs';
import { verifyEvidence } from '../agent/modeling-execution.mjs';
import { recheckAccepted } from './modeling-common-recheck.mjs';
import { verifyConfigWithTaskTrust } from './modeling-config-audit.mjs';

async function verifyRegistration(plan) {
  await verifyEvidence(plan.checkerEvidence);
  const checks=[];
  for(const entry of plan.runtimeEvidence||[]) {
    if(plan.taskTrustAdditions&&path.resolve(entry.file)===path.resolve(plan.taskTrustAdditions.file))
      checks.push(await verifyConfigWithTaskTrust(entry,plan.taskTrustAdditions.projects));
    else await verifyEvidence([entry]);
  }
  if(Object.hasOwn(plan,'modelOverride')&&(process.env.MODELING_AGENT_MODEL||null)!==plan.modelOverride)
    throw new Error('Registered review model override changed');
  return checks;
}

export async function waitForModelingBatch(file,{signal,pause=()=>new Promise(resolve=>setTimeout(resolve,30000))}={}) {
  for(;;) {
    signal?.throwIfAborted();
    const report=await readJson(file);
    if(report?.tasks?.some(row=>['FENCED','CANCELED','HOST_TIMEOUT','LAUNCH_FAILED'].includes(row.state)))
      throw new Error('Modeling batch stopped; recheck must wait for explicit process settlement');
    if(report?.finishedAt) {
      if(report.finished!==report.registered||report.tasks?.length!==report.registered||
        report.tasks.some(row=>row.state!=='FINISHED'||row.stopConfirmed!==true||row.unfinishedCalls?.length))
        throw new Error('Modeling batch has not settled');
      return;
    }
    await pause();
  }
}

export async function recheckRegisteredBatch({plan,output,signal,recheck=recheckAccepted}) {
  if(plan.protocol!==1||!plan.tasks?.length||!plan.checkerEvidence?.length)throw new Error('Frozen recheck registration required');
  const ids=new Set();
  for(const task of plan.tasks) {
    if(!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(task.id)||ids.has(task.id)||!path.isAbsolute(task.benchmarkRoot))throw new Error('Invalid or duplicate slot');
    ids.add(task.id);
  }
  await verifyRegistration(plan);
  await fs.mkdir(output);
  const report={protocol:1,planHash:hashValue(plan),registered:plan.tasks.length,rows:[],complete:false,startedAt:new Date().toISOString()};
  await atomicJson(path.join(output,'registration.json'),plan);
  const save=()=>atomicJson(path.join(output,'report.json'),report);await save();
  for(const task of plan.tasks) {
    signal?.throwIfAborted();const configurationBefore=await verifyRegistration(plan);
    const benchmark=await readJson(path.join(task.benchmarkRoot,'benchmark-report.json'));
    if(!benchmark) {
      if(!task.interruptionEvidence)throw new Error(`Registered slot lacks a terminal report: ${task.id}`);
      await verifyEvidence([task.interruptionEvidence]);
      report.rows.push({id:task.id,status:'INTERRUPTED',onlinePassed:false,interruptionEvidence:task.interruptionEvidence});await save();continue;
    }
    if(benchmark.results?.length!==1)throw new Error(`Registered slot has an unexpected sample count: ${task.id}`);
    const directory=await localPath(output,task.id.replace('/','--'));
    const row={id:task.id,status:'STARTED',output:directory,startedAt:new Date().toISOString(),configurationBefore};
    report.rows.push(row);await save();
    console.log(JSON.stringify({id:task.id,status:'STARTED'}));
    try {
      const result=await recheck({benchmarkRoot:task.benchmarkRoot,output:directory,signal});
      row.status='FINISHED';row.results=result.rows;row.onlinePassed=benchmark.results[0].passed;
      row.finishedAt=new Date().toISOString();row.configurationAfter=await verifyRegistration(plan);await save();
    } catch(error) {
      // The independent recheck already records bounded call failures. Do not replay a partial slot.
      row.status='STOPPED';row.error={kind:error.kind||null,message:error.message};await save();throw error;
    }
  }
  report.complete=true;report.finishedAt=new Date().toISOString();await save();return report;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const [file,output,mode]=process.argv.slice(2);
  if(!file||!output||mode&&mode!=='--wait')throw new Error('Usage: <registration.json> <new-output> [--wait]');
  const plan=await readJson(file),abort=new AbortController();process.on('SIGINT',()=>abort.abort());
  if(mode==='--wait') {
    if(!plan.prerequisiteReport)throw new Error('Waiting requires a registered predecessor');
    await waitForModelingBatch(plan.prerequisiteReport,{signal:abort.signal});
  }
  const report=await recheckRegisteredBatch({plan,output:path.resolve(output),signal:abort.signal});
  console.log(JSON.stringify({registered:report.registered,finished:report.rows.length,complete:report.complete}));
  if(report.rows.some(row=>row.status!=='FINISHED'||!row.onlinePassed||row.results.some(r=>r.status!=='PASS')))process.exitCode=1;
}
