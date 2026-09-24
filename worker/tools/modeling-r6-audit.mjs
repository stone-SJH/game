// Read-only task evidence aggregation. Never reruns reviewers or changes a sample's denominator.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicJson, hashFile, hashValue, readJson, localPath } from '../agent/modeling-io.mjs';

async function filesBelow(root, predicate) {
  const result=[];
  async function walk(directory) {
    for(const item of await fs.readdir(directory,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;})) {
      if(item.isSymbolicLink())throw new Error('Audit inputs must not contain links');
      const file=path.join(directory,item.name);
      if(item.isDirectory())await walk(file);else if(predicate(file))result.push(file);
    }
  }
  await walk(root);return result.sort();
}

function tally(values) { const counts={};for(const value of values)counts[value]=(counts[value]||0)+1;return counts; }
function toolFailure(item) {
  if(item?.type!=='mcp_tool_call')return null;
  const texts=(item.result?.content||[]).filter(c=>c.type==='text').map(c=>c.text);
  let result;
  for(const text of texts)try { const parsed=JSON.parse(text);if(Object.hasOwn(parsed,'exitCode'))result=parsed; } catch { /* Non-JSON tool diagnostics. */ }
  if(item.status!=='failed'&&!item.error&&!item.result?.isError&&!(result&&(result.exitCode!==0||result.error||result.timedOut||result.canceled)))return null;
  const message=[item.error?.message||item.error||'',result?.stderr||'',result?.error||'',...texts].join('\n');
  const kind=/enum.*not found|enum.*not.*(?:valid|found)|invalid.*enum/is.test(message)?'BLENDER_API_ENUM':
    /FileNotFoundError|No such file or directory/.test(message)?'FILESYSTEM_PATH':
    /TypeError:/.test(message)?'BLENDER_API_TYPE_ERROR':/KeyError:/.test(message)?'SCENE_LOOKUP':
    /AttributeError:/.test(message)?'BLENDER_API_ATTRIBUTE_ERROR':'MCP_TOOL_ERROR';
  return {tool:item.tool,kind,exitCode:result?.exitCode??null};
}
async function matchesFile(file,sha256) {
  try { return await hashFile(file)===sha256; }
  catch(error) { if(error.code==='ENOENT')return false;throw error; }
}

export async function auditModelingBatch({manifest,variant,outputRoot}) {
  const tasks=manifest.tasks.filter(task=>task.variant===variant),rows=[];
  if(!tasks.length)throw new Error('No tasks for this variant');
  if(new Set(tasks.map(t=>t.id)).size!==tasks.length||new Set(tasks.map(t=>`${t.category}-${t.repeat}`)).size!==tasks.length)throw new Error('Duplicate registered task');
  const inputIntegrity=[];
  for(const entry of manifest.inputs)inputIntegrity.push({file:entry.file,unchanged:await matchesFile(entry.file,entry.sha256)});
  for(const task of tasks) {
    const root=path.join(outputRoot,`${task.category}-${task.repeat}`),caseId=`${task.spec.assetId}-1`;
    const project=path.join(root,caseId,'project'),run=path.join(root,caseId,'run');
    const benchmark=await readJson(path.join(root,'benchmark-report.json'));
    const results=benchmark?.results||[];
    if(results.length>1)throw new Error('A registered slot contains multiple task results');
    const result=results[0];
    const interruption=await readJson(path.join(root,'runner-interruption.json'));
    const frozenSpec=await readJson(path.join(project,'plan/modeling-specs.json'));
    const specMatches=frozenSpec ? frozenSpec.assets?.length===1&&hashValue(frozenSpec.assets[0])===task.specHash : null;
    const row={id:task.id,category:task.category,repeat:task.repeat,root,
      status:result?(result.passed?'PASS':'FAIL'):interruption?'INTERRUPTED':frozenSpec?'IN_PROGRESS':'NOT_STARTED',specMatches,
      durationMs:result?.durationMs??null,terminalFailure:result?.passed===false?{kind:result.kind||'UNCLASSIFIED',message:result.error}:interruption?{kind:interruption.kind,message:interruption.reason}:null};
    const states=[];
    for(const file of await filesBelow(path.join(root,caseId,'modeling-state'),f=>path.basename(f)==='state.json')) {
      const state=await readJson(file);states.push(state);
    }
    row.authorAttempts=states.reduce((sum,s)=>sum+Object.values(s.attempts||{}).reduce((n,x)=>n+x,0),0);
    row.qualityGaps=states.flatMap(s=>s.failures||[]).filter(f=>['TECHNICAL_GAP','VISUAL_GAP'].includes(f.kind))
      .map(f=>({kind:f.kind,phase:f.phase,attemptId:f.attemptId,message:f.message}));
    row.recordedFailures=states.flatMap(s=>(s.failures||[]).map(f=>({kind:f.kind||f.reason||'UNKNOWN',phase:f.phase,attemptId:f.attemptId})));
    const calls=[];
    for(const file of await filesBelow(path.join(root,caseId,'modeling-state'),f=>path.basename(f)==='execution.json')) {
      const state=await readJson(file,null,64*1024*1024);
      for(const group of Object.values(state.groups||{})) for(const call of group.calls||[])calls.push({stage:group.stage,callId:call.callId,
        status:call.status,kind:call.error?.kind||null,stopConfirmed:call.error?.stopConfirmed??call.stopConfirmed??null});
    }
    row.calls={total:calls.length,byStage:tally(calls.map(c=>c.stage)),failures:tally(calls.filter(c=>c.kind).map(c=>c.kind)),
      inProgress:calls.filter(c=>c.status==='STARTED'),unconfirmedStops:calls.filter(c=>c.stopConfirmed===false)};
    if(row.terminalFailure?.kind==='UNCLASSIFIED'&&row.calls.unconfirmedStops.length)row.terminalFailure.kind='STOP_UNCONFIRMED';
    const rawErrors=[];const usage=[];const toolErrors=[];
    for(const file of await filesBelow(run,f=>f.endsWith('.stdout.log'))) {
      for(const line of (await fs.readFile(file,'utf8')).split(/\r?\n/)) {
        let event;try{event=JSON.parse(line);}catch{continue;}
        if(event.type==='error'||event.type==='turn.failed') {
          const message=event.message||event.error?.message||'';
          rawErrors.push({file,type:event.type,httpStatus:message.match(/(?:status|HTTP)\s+(\d{3})/)?.[1]||null});
        }
        if(event.type==='turn.completed'&&event.usage)usage.push({file,usage:event.usage});
        if(event.type==='item.completed') { const failure=toolFailure(event.item);if(failure)toolErrors.push({file,itemId:event.item.id,...failure}); }
      }
    }
    row.serviceEvidence={errorEvents:rawErrors.length,httpStatusCounts:tally(rawErrors.filter(e=>e.httpStatus).map(e=>e.httpStatus)),
      files:[...new Set(rawErrors.map(e=>e.file))]};row.completedCallUsage=usage;
    row.toolEvidence={failureCounts:tally(toolErrors.map(e=>e.kind)),failures:toolErrors};
    row.assets=[];
    for(const asset of result?.summary?.assets||[]) {
      const fileChecks=[];
      for(const file of asset.files) {
        const absolute=await localPath(project,file.path);fileChecks.push({path:file.path,unchanged:await matchesFile(absolute,file.sha256)});
      }
      row.assets.push({assetId:asset.assetId,route:asset.route,originalRoute:asset.originalRoute,status:asset.status||'LEGACY_ACCEPTED',
        filesChecked:fileChecks.length,changedFiles:fileChecks.filter(f=>!f.unchanged)});
    }
    row.acceptedEvidencePresent=result?.passed===true?specMatches===true&&row.assets.length>0&&row.assets.every(a=>a.filesChecked>0):null;
    row.sourceUnchanged=null;
    if(task.category==='reuse'&&frozenSpec) {
      const original=manifest.inputs.find(i=>i.file.toLowerCase().endsWith('.blend'));
      if(!original)throw new Error('Reuse source is not registered');
      try {row.sourceUnchanged=await hashFile(path.join(project,'existing.blend'))===original.sha256;}
      catch(e){if(e.code!=='ENOENT')throw e;row.sourceUnchanged=false;}
    }
    rows.push(row);
  }
  const categories={};
  for(const category of new Set(rows.map(r=>r.category))) {
    const selected=rows.filter(r=>r.category===category);
    categories[category]={registered:selected.length,finished:selected.filter(r=>['PASS','FAIL','INTERRUPTED'].includes(r.status)).length,
      passed:selected.filter(r=>r.status==='PASS').length,failed:selected.filter(r=>['FAIL','INTERRUPTED'].includes(r.status)).length,
      ...(category==='reuse'?{reusedAndPassed:selected.filter(r=>r.status==='PASS'&&r.acceptedEvidencePresent&&r.assets.every(a=>a.route==='reuse_blender')&&r.sourceUnchanged).length}:{}),
      durationMs:selected.map(r=>r.durationMs).filter(n=>n!==null)};
  }
  const integrityPassed=inputIntegrity.every(r=>r.unchanged)&&rows.every(r=>r.specMatches!==false&&r.sourceUnchanged!==false&&r.acceptedEvidencePresent!==false&&r.assets.every(a=>a.changedFiles.length===0));
  return {protocol:1,observedAt:new Date().toISOString(),variant,registered:tasks.length,finished:rows.filter(r=>['PASS','FAIL','INTERRUPTED'].includes(r.status)).length,
    integrityPassed,inputIntegrity,categories,rows,
    note:'PASS is the preserved online task result, not supplemental UE or traversal acceptance. Incomplete samples remain in the registered denominator. Error event counts include CLI reconnection events, not additional host calls. Usage covers only completed calls and is not a total cost estimate.'};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const args=process.argv.slice(2);
  if(args.length!==4)throw new Error('Usage: <manifest.json> <variant> <actual-output-root> <new-report.json>');
  const [file,variant,outputRoot,report]=args;
  try{await fs.access(report);throw new Error('Audit report already exists; preserve the old snapshot');}catch(e){if(e.code!=='ENOENT')throw e;}
  const value=await auditModelingBatch({manifest:await readJson(file),variant,outputRoot});
  await atomicJson(report,value);console.log(JSON.stringify({registered:value.registered,finished:value.finished,integrityPassed:value.integrityPassed,categories:value.categories}));
  if(!value.integrityPassed)process.exitCode=1;
}
