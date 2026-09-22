// Explicit live quality benchmark. Output is retained outside the repository.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createModelingPipeline } from '../agent/modeling-pipeline.mjs';
import { defaultContract } from '../agent/modeling-contract.mjs';
import { codexInvocation } from '../agent/production-harness.mjs';
import { createTripoProvider } from '../agent/providers/tripo.mjs';
import { runCommand } from '../agent/process-runner.mjs';
import { atomicJson } from '../agent/modeling-io.mjs';

const cases = {
  'hard-surface': { description:'A red metal wall cabinet, with a recessed front door, black pull handle, brass hinges and beveled edges.',
    requirements:['The cabinet has a red rectangular metal body and a separate recessed front door.', 'A black pull handle and two brass hinges are visible on the front.', 'Edges are visibly beveled rather than razor sharp.'],
    contract:defaultContract({styleProfile:'hard-surface',dimensions:{meters:[.6,.3,.8],toleranceMeters:.02}}), maxTriangles:6000 },
  lowpoly: { description:'A flat shaded low-poly wood and steel axe with a clearly curved broad blade and a long brown handle.',
    requirements:['A broad steel axe blade with a curved cutting edge is visible.', 'The blade is attached to a long brown wooden handle.', 'The style is flat shaded low-poly with clear contrasting material colors.'],
    contract:defaultContract({styleProfile:'lowpoly',dimensions:{meters:[.3,.06,1.2],toleranceMeters:.03}}),maxTriangles:1200 },
  modular: { description:'A stone doorway module with two pillars and a horizontal lintel; the doorway opening must remain empty and traversable.',
    requirements:['Two stone pillars support one horizontal lintel.', 'The central doorway is an empty opening, without a solid wall blocking it.'],
    contract:defaultContract({assetClass:'modular-kit',styleProfile:'hard-surface',dimensions:{meters:[2.4,.4,2.8],toleranceMeters:.01},
      runtime:{engine:'unreal',profile:'fbx-static',collision:'convex',lodTriangles:[1000],sockets:[],animations:[],lightmapUV:false}}),maxTriangles:4000 },
  organic: { description:'A stylized brown tree stump with an irregular top, visible concentric growth rings and three flared roots.',
    requirements:['A brown stump has a visibly irregular top edge.', 'The top shows concentric growth rings.', 'Three flared roots join the trunk continuously.'],
    contract:defaultContract({assetClass:'organic-static'}),maxTriangles:12000 },
  rig: { description:'A simple rigged toy robot with two arms and legs and a short arm wave animation named Wave.',
    requirements:['The toy robot has a head, torso, two arms and two legs.', 'The Wave action visibly raises and lowers one arm while the torso stays stable.'],requireRig:true,
    contract:defaultContract({assetClass:'skeletal-character',runtime:{engine:'none',profile:'fbx-skeletal',collision:'none',lodTriangles:[],sockets:[],animations:['Wave'],lightmapUV:false}}),maxTriangles:6000 },
};
const argv=process.argv.slice(2);
const option=(name,fallback)=>argv.includes(name)?argv[argv.indexOf(name)+1]:fallback;
for(let i=0;i<argv.length;i++) { if(['--case','--out','--repeat','--reference','--reuse-source','--variant'].includes(argv[i]))i++;else if(!['--tripo'].includes(argv[i]))throw new Error('Unknown benchmark option'); }
const caseName=option('--case','hard-surface');if(!cases[caseName])throw new Error('Unknown case');
const repeats=Number(option('--repeat','1'));if(!Number.isInteger(repeats)||repeats<1||repeats>3)throw new Error('repeat must be 1..3');
const root=path.resolve(option('--out',await fs.mkdtemp(path.join(os.tmpdir(),'modeling-v2-live '))));
await fs.mkdir(root,{recursive:true});
const abort=new AbortController();process.on('SIGINT',()=>abort.abort(new Error('Benchmark canceled')));
const results=[];
console.log(JSON.stringify({root,caseName,repeats,liveAuthor:true,liveEvaluation:true,liveVisualReview:true,providerEnabled:argv.includes('--tripo')}));
for(let i=0;i<repeats;i++) {
  const started=Date.now(),id=`${caseName}-${i+1}`,project=path.join(root,id,'project'),output=path.join(root,id,'run');
  await fs.mkdir(project,{recursive:true});await fs.mkdir(output,{recursive:true});
  const sample=cases[caseName];
  const spec={assetId:caseName,prompt:sample.description,referenceImages:[],requireRig:false,requireClosedMesh:false,...sample};
  const reference=option('--reference');
  if(reference) {
    await fs.mkdir(path.join(project,'references'),{recursive:true});
    await fs.copyFile(path.resolve(reference),path.join(project,'references','input.png'));
    spec.referenceImages=['references/input.png'];
    spec.requirements=[...spec.requirements,'The silhouette and color regions follow the supplied reference image.'];
  }
  const source=option('--reuse-source');
  if(source) {
    const {registerModelingAsset}=await import('../agent/asset-catalog.mjs');
    const {hashFile}=await import('../agent/modeling-io.mjs');
    const destination=path.join(project,'existing.blend');await fs.copyFile(path.resolve(source),destination);
    await registerModelingAsset(project,{path:'existing.blend',sha256:await hashFile(destination),description:sample.description,source:'Earlier benchmark, copied for local revision',license:'Task authored',previewImages:[]});
    spec.description=spec.description.replaceAll('red','blue');spec.prompt=spec.description;
    spec.requirements=spec.requirements.map(r=>r.replaceAll('red','blue'));
  }
  if(option('--variant','v2')==='legacy')delete spec.contract;
  const pipeline=createModelingPipeline({job:{taskId:id,workspaceId:id,runId:'benchmark',objective:spec.description,modelingSpecs:[spec]},project,output,signal:abort.signal,
    invocation:codexInvocation([]),provider:createTripoProvider(argv.includes('--tripo')?{}:{keyFile:path.join(root,'no-provider-key')}),
    reportProgress:async value=>console.log(JSON.stringify({case:id,step:value.step})),
    step:async(name,command,args,timeoutMs,cwd,accepts,options={})=>{
      console.log(JSON.stringify({case:id,stage:name,state:'started'}));
      const result=await runCommand(command,args,{...options,cwd,timeoutMs,signal:abort.signal,stdoutFile:path.join(output,name+'.stdout.log'),stderrFile:path.join(output,name+'.stderr.log')});
      if(!result.stopConfirmed)throw Object.assign(new Error('Unconfirmed process stop'),{stopConfirmed:false});
      if(result.exitCode!==0||result.error||result.timedOut||result.canceled)throw Object.assign(new Error(`Benchmark step failed ${name}: ${result.timedOut?'shared attempt timeout':result.canceled?'canceled':result.error||`exit ${result.exitCode}`}; ${result.stderr.slice(-1200)}`),{result});
      return result;
    }});
  try { const summary=await pipeline.prepare();await pipeline.verify();results.push({id,passed:true,durationMs:Date.now()-started,summary}); }
  catch(error){results.push({id,passed:false,durationMs:Date.now()-started,error:error.message});if(abort.signal.aborted)throw error;}
  await atomicJson(path.join(root,'benchmark-report.json'),{protocol:2,caseName,liveAuthor:true,liveVisualReview:true,results});
  console.log(JSON.stringify({case:id,passed:results.at(-1).passed,durationMs:Date.now()-started,error:results.at(-1).error}));
}
if(results.some(r=>!r.passed))process.exitCode=1;
