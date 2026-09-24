// Serial runner for a frozen benchmark plan. A started slot is never automatically replayed.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runCommand } from '../agent/process-runner.mjs';
import { atomicJson, hashFile, hashValue, readJson } from '../agent/modeling-io.mjs';
import { verifyConfigWithTaskTrust } from './modeling-config-audit.mjs';
const execute=promisify(execFile);

async function absent(file) {
  try { await fs.lstat(file);throw new Error(`Output already exists: ${file}`); }
  catch(error) { if(error.code!=='ENOENT')throw error; }
}

export async function verifyBatch(plan) {
  if(plan.protocol!==1||!plan.tasks?.length||!plan.execution?.mode)throw new Error('Explicit execution plan required');
  if(!['DIAGNOSTIC_R4_FAILED','CALIBRATED'].includes(plan.execution.mode))throw new Error('Unknown admission mode');
  if(plan.execution.mode==='CALIBRATED'&&!(await readJson(plan.admission.calibrationReport))?.passed)throw new Error('Calibration has not passed');
  if(plan.settings.providerEnabled!==false)throw new Error('This comparison runner requires the registered provider-disabled policy');
  const ids=new Set(),outputs=new Set();
  for(const task of plan.tasks) {
    if(ids.has(task.id)||hashValue(task.spec)!==task.specHash)throw new Error('Duplicate task or modified specification');ids.add(task.id);
    if(!Array.isArray(task.args)||!path.isAbsolute(task.args[0])||path.basename(task.args[0])!=='modeling-v2-probe.mjs')throw new Error('Probe script must be the first argument');
    const index=task.args.indexOf('--out'),out=task.args[index+1];
    if(index<1||!path.isAbsolute(out)||outputs.has(path.resolve(out))||task.args.includes('--tripo'))throw new Error('Invalid output or provider policy');
    if(task.args[task.args.indexOf('--repeat')+1]!=='1')throw new Error('Each registered slot must contain exactly one sample');
    if(task.command!==process.execPath)throw new Error('Node executable differs from this runner');
    const repository=path.resolve(task.args[0],'../../..');
    if(!plan.execution.repositories.some(r=>path.resolve(r.path)===repository))throw new Error('Unregistered repository');
    outputs.add(path.resolve(out));await absent(out);
  }
  await verifyFrozenInputs(plan);
}

async function verifyFrozenInputs(plan) {
  const configChecks=[];
  for(const file of [...plan.inputs,...plan.settings.runtime.files]) {
    if(plan.execution.taskTrustAdditions&&path.resolve(file.file)===path.resolve(plan.execution.taskTrustAdditions.file))
      configChecks.push(await verifyConfigWithTaskTrust(file,plan.execution.taskTrustAdditions.projects));
    else if(await hashFile(file.file)!==file.sha256)throw new Error(`Frozen input changed: ${file.file}`);
  }
  for(const repository of plan.execution.repositories) {
    const options={cwd:repository.path,windowsHide:true};
    const {stdout:head}=await execute('git',['rev-parse','HEAD'],options);
    if(head.trim()!==repository.commit)throw new Error('Repository commit changed');
    const {stdout:changes}=await execute('git',['status','--porcelain','--untracked-files=all','--','worker','skills'],options);
    if(changes.trim())throw new Error('Benchmark code has uncommitted changes');
  }
  return configChecks;
}

async function unfinishedCalls(root) {
  const pending=[];
  async function walk(directory) {
    for(const entry of await fs.readdir(directory,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;})) {
      const file=path.join(directory,entry.name);
      if(entry.isSymbolicLink())throw new Error('Benchmark state contains a link');
      if(entry.isDirectory())await walk(file);
      else if(entry.name==='execution.json') {
        const state=await readJson(file,null,64*1024*1024);
        for(const group of Object.values(state.groups||{}))for(const call of group.calls||[])
          if(call.status==='STARTED'||call.error?.stopConfirmed===false)pending.push({file,callId:call.callId});
      }
    }
  }
  for(const entry of await fs.readdir(root,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;}))
    if(entry.isDirectory())await walk(path.join(root,entry.name,'modeling-state'));
  return pending;
}

export async function runRegisteredBatch({plan,logDirectory,signal,launch=runCommand,verify=verifyFrozenInputs}) {
  await verifyBatch(plan);
  if(plan.execution.prerequisite)await verifyPrerequisite(plan.execution.prerequisite);
  await fs.mkdir(logDirectory); // Logs live outside task outputs; the probe creates its own --out directory.
  const reportFile=path.join(logDirectory,'report.json');
  const report={protocol:1,planHash:hashValue(plan),startedAt:new Date().toISOString(),mode:plan.execution.mode,
    registered:plan.tasks.length,finished:0,tasks:[]};
  await atomicJson(path.join(logDirectory,'plan.json'),plan);await atomicJson(reportFile,report);
  const policy=plan.settings.policy;
  const env={...process.env,MODELING_HARNESS_V2_ENABLED:'1',MODELING_BUILD_TIMEOUT_MS:String(policy.buildMs),
    MODELING_CLEANUP_TIMEOUT_MS:String(policy.cleanupMs),MODELING_EVALUATION_TIMEOUT_MS:String(policy.reviewMs)};
  for(const task of plan.tasks) {
    signal?.throwIfAborted();const configurationBefore=await verify(plan);
    const out=task.args[task.args.indexOf('--out')+1];await absent(out);
    await fs.mkdir(path.dirname(out),{recursive:true});
    const label=task.id.replaceAll('/','--');
    const row={id:task.id,state:'STARTED',startedAt:new Date().toISOString(),output:out,configurationBefore,
      stdout:path.join(logDirectory,label+'.stdout.log'),stderr:path.join(logDirectory,label+'.stderr.log')};
    report.tasks.push(row);await atomicJson(reportFile,report);
    console.log(JSON.stringify({id:task.id,state:row.state}));
    const result=await launch(task.command,task.args,{cwd:path.resolve(task.args[0],'../../..'),env,signal,
      // This watchdog only contains a stuck benchmark host. Author/review deadlines remain unchanged.
      timeoutMs:4*60*60*1000,stdoutFile:row.stdout,stderrFile:row.stderr});
    Object.assign(row,{finishedAt:new Date().toISOString(),exitCode:result.exitCode,stopConfirmed:result.stopConfirmed,
      timedOut:result.timedOut,canceled:result.canceled,error:result.error||null});
    const benchmark=await readJson(path.join(out,'benchmark-report.json'));
    row.unfinishedCalls=await unfinishedCalls(out);
    const uncertain=row.unfinishedCalls.length>0||benchmark?.results?.some(r=>r.kind==='STOP_UNCONFIRMED');
    row.state=result.stopConfirmed===false||uncertain?'FENCED':result.canceled?'CANCELED':result.timedOut?'HOST_TIMEOUT':benchmark?.results?.length===1?'FINISHED':'LAUNCH_FAILED';
    row.passed=benchmark?.results?.[0]?.passed??null;
    if(row.state==='FINISHED')report.finished++;
    await atomicJson(reportFile,report);console.log(JSON.stringify(row));
    if(row.state!=='FINISHED')throw new Error(`Batch stopped without replay: ${row.state}`);
    row.configurationAfter=await verify(plan);await atomicJson(reportFile,report);
  }
  report.finishedAt=new Date().toISOString();await atomicJson(reportFile,report);return report;
}

export async function verifyPrerequisite(prerequisite) {
  const report=await readJson(prerequisite.completionReport);
  if(report?.tasks?.length!==prerequisite.candidateRegistered)throw new Error('Candidate batch is not complete');
  for(const row of report.tasks) {
    const output=row.out||row.output;
    const relative=path.relative(prerequisite.candidateOutput,output);
    if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Candidate output is outside its registered root');
    const result=await readJson(path.join(output,'benchmark-report.json'));
    if(result?.results?.length!==1)throw new Error('Candidate task has no terminal model result');
    if((await unfinishedCalls(output)).length||result.results[0].kind==='STOP_UNCONFIRMED')throw new Error('Candidate contains an unconfirmed nested process');
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const [file,logDirectory,mode]=process.argv.slice(2);
  if(!file||!logDirectory||mode&&!['--check','--wait'].includes(mode))throw new Error('Usage: <execution-plan.json> <new-log-directory> [--check|--wait]');
  const plan=await readJson(file);await verifyBatch(plan);
  if(mode==='--check')console.log(JSON.stringify({valid:true,tasks:plan.tasks.length,mode:plan.execution.mode}));
  else {
    const abort=new AbortController();process.on('SIGINT',()=>abort.abort(new Error('Batch canceled')));
    if(mode==='--wait') {
      if(!plan.execution.prerequisite)throw new Error('Waiting requires an explicit candidate prerequisite');
      console.log(JSON.stringify({state:'WAITING_FOR_CANDIDATE',file:plan.execution.prerequisite.completionReport}));
      while(!await readJson(plan.execution.prerequisite.completionReport)) {
        abort.signal.throwIfAborted();await new Promise(resolve=>setTimeout(resolve,30000));
      }
    }
    await runRegisteredBatch({plan,logDirectory,signal:abort.signal});
  }
}
