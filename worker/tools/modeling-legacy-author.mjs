// Probe-only single-stage author adapter. The full v2 specification and common host gates remain intact.
import path from 'node:path';
import { atomicJson, readJson, localPath, recordAuthorRecipe, agentEnvironment } from '../agent/modeling-io.mjs';
import { createExecutionStore, executionPolicy, fileEvidence, verifyEvidence } from '../agent/modeling-execution.mjs';
import { blenderMcpArgs } from '../agent/modeling-capabilities.mjs';

export function createSingleStageAuthor({ project, output, signal, step, invocation }) {
  const execution=createExecutionStore(path.join(path.dirname(project),'modeling-state','single-stage-author'),{signal});
  const policy=executionPolicy(invocation);
  return async context=>{
    await execution.assertSettled();
    const {spec,directory,receiptFile,sourceFile,feedback,attemptId}=context;
    const paths=['source.blend','model.glb','recipe.py','asset-manifest.json','build-report.json',...(spec.contract.runtime.profile.startsWith('fbx')?['model.fbx']:[])];
    const prompt=[
      'You are the asset production specialist for one bounded modeling attempt. Read the create-game-assets skill if available.',
      `Task workspace: ${project}. Use the yahaha_blender MCP blender_run_python tool. Every call starts a fresh scene; explicitly reopen the saved source to continue.`,
      `Asset specification (complete and immutable): ${JSON.stringify(spec)}`, `Host decision: ${JSON.stringify(context.decision)}`,
      `Exact output directory: ${directory}. Deliver ${paths.join(', ')} here within this single author call. Meet every original requirement; do not substitute a default cube or reduce fidelity.`,
      sourceFile?`Open the supplied source copy ${sourceFile} and implement the bounded edit plan. Preserve the original source.`:'Build the required model directly using bpy.',
      `Previous repair findings: ${JSON.stringify(feedback||null)}`,
      ...(context.previousAttemptDirectory?[`Previous attempt: ${context.previousAttemptDirectory}. Repair usable content and write into this new directory.`]:[]),
      'Full-contract compatibility appendix: recipe.py is executable and source.blend packs textures. asset-manifest.json declares rootObject and objects [{name,role,lod}]; roles are render-mesh, lod, collision, helper. Every mesh must be declared. GLB contains only LOD0 render geometry and its required rig. FBX includes required collision/LODs/sockets and actions. Missing contract outputs remain GAP.',
      'Write build-report.json as {"smallEditsOnly":true,"editsApplied":["actual edits"],"limitations":[]}. Report whether edits were local; this report does not authorize acceptance.',
      'The host owns independent technical/visual acceptance. Do not generate a separate blockout stage, call third-party generation, start child agents, edit accepted resources, integrate UE or package a game.',
    ].join('\n');
    const result=await execution.run({key:`author:${attemptId}`,stage:'AUTHOR',identity:{attemptId,variant:'single-stage-full-contract'},
      input:{spec,prompt,deadlineAt:context.deadlineAt,policy},timeoutMs:policy.buildMs},async({callId,timeoutMs})=>{
      const remaining=Math.min(timeoutMs,context.deadlineAt-Date.now());if(remaining<=0)throw new Error('Original author attempt deadline exhausted');
      const response=path.join(output,`single-stage-${attemptId}-${callId}.txt`);
      const args=[...invocation.args,'exec','--json','--ephemeral','--skip-git-repo-check','--dangerously-bypass-approvals-and-sandbox',
        '-c','features.multi_agent=false','-c','features.multi_agent_v2=false','-c','mcp_servers={}','--cd',project,...blenderMcpArgs(project,receiptFile),'-o',response];
      if(process.env.MODELING_AGENT_MODEL)args.push('--model',process.env.MODELING_AGENT_MODEL);
      for(const image of spec.referenceImages)args.push('--image',await localPath(project,image,{existing:true}));
      args.push('-');
      const input=`${prompt}\nRemaining shared attempt time: ${Math.floor(remaining/1000)} seconds. Deadline: ${new Date(context.deadlineAt).toISOString()}.`;
      await atomicJson(path.join(output,`single-stage-${attemptId}-${callId}-request.json`),{spec,prompt:input,remainingMs:remaining});
      await step(`single-stage-${attemptId}-${callId}`,invocation.command,args,remaining,project,undefined,{input,env:agentEnvironment()});
      const receipt=await readJson(receiptFile);
      if(receipt?.calls?.some(c=>c.stopConfirmed===false))throw Object.assign(new Error('Blender stop unconfirmed'),{stopConfirmed:false});
      if(!receipt?.calls?.some(c=>c.tool==='blender_run_python'&&c.exitCode===0&&c.stopConfirmed&&!c.canceled&&!c.timedOut))throw new Error('Missing successful author MCP receipt');
      const stageArtifacts=await recordAuthorRecipe(project,directory,receipt);
      const files=[];for(const name of [...paths.map(name=>`${directory}/${name}`),...stageArtifacts])files.push(await localPath(project,name,{existing:true}));
      return {stageArtifacts,evidence:await fileEvidence([receiptFile,...files])};
    });
    await verifyEvidence(result.evidence);context.stageArtifacts=result.stageArtifacts;
  };
}
