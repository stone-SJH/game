// Explicit offline calibration: five independent slots per preregistered pack, never production voting.
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, readJson, hashValue } from '../agent/modeling-io.mjs';
import { createExecutionStore, fileEvidence, executionPolicy, verifyEvidence } from '../agent/modeling-execution.mjs';
import { createModelingReviewer } from '../agent/modeling-review.mjs';
import { visualEvidence, visualRubric, visualReviewPrompt } from '../agent/modeling-rubric.mjs';
import { visualSchemaFor, reviewPasses } from '../agent/modeling-evaluation.mjs';
import { defaultContract } from '../agent/modeling-contract.mjs';
import { modelingRuntimeIdentity } from '../agent/modeling-runtime-lock.mjs';
import { pinToolchain } from '../agent/modeling-skill-routing.mjs';
import { codexInvocation } from '../agent/production-harness.mjs';
import { runCommand } from '../agent/process-runner.mjs';

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--fixtures' || args[2] !== '--out') throw new Error('Usage: --fixtures <preregistered JSON> --out <calibration directory>');
const fixturesFile = path.resolve(args[1]), root = path.resolve(args[3]);
await fs.mkdir(root, { recursive: true });
const fixtures = await readJson(fixturesFile);
if (fixtures?.cases?.length !== 12 || ['clear-positive','clear-negative','borderline'].some(group => fixtures.cases.filter(c=>c.group===group).length!==4)) throw new Error('Expected 4 positive, 4 negative and 4 borderline packs.');
const invocation = codexInvocation([]), signal = new AbortController();
process.on('SIGINT',()=>signal.abort(new Error('Calibration canceled')));
const packs = fixtures.cases.map(item => {
  const spec = { assetId: 'calibration-stump', description: 'A stylized brown tree stump with an irregular top, concentric growth rings and three flared roots.',
    prompt: 'A brown stump', requirements: item.requirements, referenceImages: [], maxTriangles: 12000, requireRig: false, requireClosedMesh: false,
    contract: defaultContract({ assetClass: 'organic-static' }) };
  const images = item.views.map(v=>v.file), evidence = visualEvidence(item.views.map(v=>v.view));
  return { id: item.id, group: item.group, expected: item.expected, spec, images, evidence,
    schema: visualSchemaFor(spec,evidence), prompt: visualReviewPrompt({spec,evidence,metrics:{evidenceType:'Fixed views of actual GLB reimport'}}), rubric:visualRubric(spec) };
});
const frozen = { protocol:1, repeats:5, concurrency:2, maximumCalls:180, policy:executionPolicy(invocation),
  runtime:await modelingRuntimeIdentity(invocation,root), packs, files:await fileEvidence([fixturesFile,...packs.flatMap(p=>p.images)]) };
await pinToolchain(root,'calibration',frozen);
await verifyEvidence(frozen.files);
const tasks=packs.flatMap(pack=>Array.from({length:5},(_,i)=>({pack,repeat:i+1}))), rows=[];
let next=0, saving=Promise.resolve();
function report() {
  const clear=rows.filter(r=>r.group!=='borderline'), valid=clear.filter(r=>r.valid);
  let consistent=0, comparisons=0, truth=0;
  for(const pack of packs.filter(p=>p.group!=='borderline')) for(let i=0;i<pack.spec.requirements.length;i++) {
    const judgments=valid.filter(r=>r.id===pack.id).map(r=>r.statuses[i]);
    consistent+=Math.max(judgments.filter(x=>x==='PASS').length,judgments.filter(x=>x==='GAP').length);
    comparisons+=judgments.length;truth+=judgments.filter(x=>x===pack.expected[i]).length;
  }
  const falseAccepts=rows.filter(r=>r.group==='clear-negative'&&r.valid&&r.accepted).length;
  const completed=rows.filter(r=>r.valid).length;
  const metrics={slots:60,finished:rows.length,valid:completed,clearJudgments:comparisons,consistency:comparisons?consistent/comparisons:null,
    truthAgreement:comparisons?truth/comparisons:null,negativeSlots:20,negativeValid:rows.filter(r=>r.group==='clear-negative'&&r.valid).length,falseAccepts};
  const passed=completed===60&&metrics.consistency>=.9&&metrics.truthAgreement>=.9&&falseAccepts===0;
  return {protocol:1,manifestHash:hashValue(frozen),passed,metrics,rows:[...rows].sort((a,b)=>a.id.localeCompare(b.id)||a.repeat-b.repeat)};
}
async function work() {
  while(next<tasks.length) {
    const {pack,repeat}=tasks[next++], directory=path.join(root,`${pack.id}-${repeat}`);await fs.mkdir(directory,{recursive:true});
    const execution=createExecutionStore(directory,{signal:signal.signal});await execution.assertSettled();
    const review=createModelingReviewer({execution,project:root,output:directory,signal:signal.signal,invocation,
      step:async(name,command,argv,timeoutMs,cwd,accepts,options={})=>{
        const result=await runCommand(command,argv,{...options,cwd,timeoutMs,signal:signal.signal,stdoutFile:path.join(directory,name+'.stdout.log'),stderrFile:path.join(directory,name+'.stderr.log')});
        if(result.exitCode!==0||result.error||result.timedOut||result.canceled||!result.stopConfirmed)throw Object.assign(new Error(`Review execution failed: ${result.error||result.exitCode}`),{result});
        return result;
      }});
    const start=Date.now(); let row;
    try {
      const result=await review({name:'fixed-image-review',key:'review',schema:pack.schema,prompt:pack.prompt,images:pack.images,
        validate:value=>reviewPasses(value,pack.spec,pack.evidence)});
      row={id:pack.id,group:pack.group,repeat,valid:true,accepted:reviewPasses(result,pack.spec,pack.evidence),
        statuses:pack.spec.requirements.map(criterion=>result.criteria.find(c=>c.criterion===criterion).status),result};
    } catch(error) { row={id:pack.id,group:pack.group,repeat,valid:false,kind:error.kind||'UNKNOWN',error:error.message};if(signal.signal.aborted||error.stopConfirmed===false)throw error; }
    const state=await readJson(path.join(directory,'execution.json'));
    row.calls=Object.values(state?.groups||{}).reduce((sum,g)=>sum+g.calls.length,0);row.durationMs=Date.now()-start;
    rows.push(row); const snapshot=report(); saving=saving.then(()=>atomicJson(path.join(root,'report.json'),snapshot));await saving;
    console.log(JSON.stringify({id:row.id,repeat,valid:row.valid,accepted:row.accepted,statuses:row.statuses,calls:row.calls,completed:rows.length}));
  }
}
await Promise.all([work(),work()]);await verifyEvidence(frozen.files);
const final=report();await atomicJson(path.join(root,'report.json'),final);console.log(JSON.stringify(final.metrics));if(!final.passed)process.exitCode=1;
