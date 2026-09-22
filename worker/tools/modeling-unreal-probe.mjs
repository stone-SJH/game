import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runCommand } from '../agent/process-runner.mjs';
import { blenderExecutable } from '../agent/modeling-capabilities.mjs';
import { defaultContract } from '../agent/modeling-contract.mjs';
import { atomicJson, hashFile, readJson, repositoryRoot } from '../agent/modeling-io.mjs';
import { validateUnrealModels } from '../agent/modeling-unreal.mjs';
import { codexInvocation } from '../agent/production-harness.mjs';

const root=process.argv[2]?path.resolve(process.argv[2]):await fs.mkdtemp(path.join(os.tmpdir(),'modeling-unreal-probe '));
const doorway=process.argv[3]==='door', probeDimensions=doorway?[2.4,.4,2.8]:[1,.4,2];
await fs.mkdir(root,{recursive:true});
const projectFile=path.join(root,'ModelingProbe.uproject');
await atomicJson(projectFile,{FileVersion:3,EngineAssociation:'5.8',Category:'Tests',Plugins:[{Name:'PythonScriptPlugin',Enabled:true},{Name:'EditorScriptingUtilities',Enabled:true}]});
await fs.mkdir(path.join(root,'Config'),{recursive:true});
await fs.writeFile(path.join(root,'Config/DefaultEngine.ini'),'[/Script/Engine.RendererSettings]\nr.DynamicGlobalIlluminationMethod=0\nr.ReflectionMethod=0\nr.Shadow.Virtual.Enable=0\n');
const blenderScript=path.join(root,'author.py');
await fs.writeFile(blenderScript,`import bpy,os\nbpy.ops.wm.read_factory_settings(use_empty=True)\nroot=${JSON.stringify(root)}\nbpy.ops.mesh.primitive_cube_add(size=1)\nobj=bpy.context.object\nobj.name='SM_Probe'\nobj.scale=(1,.4,2)\nbpy.ops.object.transform_apply(location=False,rotation=False,scale=True)\nmat=bpy.data.materials.new('ProbeRed')\nmat.use_nodes=True\nmat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=(.6,.02,.01,1)\nobj.data.materials.append(mat)\nbpy.ops.export_scene.fbx(filepath=os.path.join(root,'lod1.fbx'),use_selection=True,add_leaf_bones=False,bake_anim=False,mesh_smooth_type='FACE')\nbevel=obj.modifiers.new('Edges','BEVEL')\nbevel.width=.02\nbevel.segments=2\nbpy.ops.mesh.primitive_cube_add(size=1)\ncol=bpy.context.object\ncol.name='UCX_SM_Probe_00'\ncol.scale=(1,.4,2)\nbpy.ops.object.transform_apply(location=False,rotation=False,scale=True)\nobj.select_set(True)\nbpy.context.view_layer.objects.active=obj\nbpy.ops.export_scene.fbx(filepath=os.path.join(root,'model.fbx'),use_selection=True,add_leaf_bones=False,bake_anim=False,mesh_smooth_type='FACE')\nbpy.ops.wm.save_as_mainfile(filepath=os.path.join(root,'source.blend'))\n`);
const controller=new AbortController();process.on('SIGINT',()=>controller.abort());
if(doorway)await fs.writeFile(blenderScript,`import bpy,os
bpy.ops.wm.read_factory_settings(use_empty=True)
root=${JSON.stringify(root)}
mat=bpy.data.materials.new('ProbeRed')
mat.use_nodes=True
mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=(.6,.02,.01,1)
parts=[]
shapes=[((-1,0,1.2),(.4,.4,2.4)),((1,0,1.2),(.4,.4,2.4)),((0,0,2.6),(2.4,.4,.4))]
for location,scale in shapes:
 bpy.ops.mesh.primitive_cube_add(size=1,location=location)
 obj=bpy.context.object;obj.scale=scale
 bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
 obj.data.materials.append(mat);parts.append(obj)
for obj in parts:obj.select_set(True)
bpy.context.view_layer.objects.active=parts[0]
bpy.ops.object.join()
obj=bpy.context.object;obj.name='SM_Probe'
bpy.context.scene.cursor.location=(0,0,0)
bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
bpy.ops.export_scene.fbx(filepath=os.path.join(root,'lod1.fbx'),use_selection=True,add_leaf_bones=False,bake_anim=False,mesh_smooth_type='FACE')
bevel=obj.modifiers.new('Edges','BEVEL');bevel.width=.02;bevel.segments=2
collisions=[]
for i,(location,scale) in enumerate(shapes):
 bpy.ops.mesh.primitive_cube_add(size=1,location=location)
 col=bpy.context.object;col.name='UCX_SM_Probe_'+str(i).zfill(2);col.scale=scale
 bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
 collisions.append(col)
bpy.ops.object.select_all(action='DESELECT')
for item in [obj]+collisions:item.select_set(True)
bpy.context.view_layer.objects.active=obj
bpy.ops.export_scene.fbx(filepath=os.path.join(root,'model.fbx'),use_selection=True,add_leaf_bones=False,bake_anim=False,mesh_smooth_type='FACE')
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(root,'source.blend'))
`);
async function command(name,exe,args,timeoutMs){
 const result=await runCommand(exe,args,{cwd:root,timeoutMs,signal:controller.signal,stdoutFile:path.join(root,name+'.stdout.log'),stderrFile:path.join(root,name+'.stderr.log')});
 if(result.exitCode!==0||result.error||result.timedOut)throw new Error(`${name}: ${result.error||result.stderr.slice(-2000)||result.stdout.slice(-2000)}`);
}
await command('blender',blenderExecutable(),['--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',blenderScript],90000);
const spec={assetId:'probe',requirements:['The imported object is a red beveled upright rectangular block.'],maxTriangles:1000,requireRig:false,
 contract:defaultContract({dimensions:{meters:[1,.4,2],toleranceMeters:.01},runtime:{engine:'unreal',profile:'fbx-static',collision:'convex',lodTriangles:[20],sockets:[],animations:[],lightmapUV:false}})};
spec.contract.dimensions.meters=probeDimensions;
spec.contract.pivot={mode:doorway?'base-center':'center',meters:null,toleranceMeters:.01};
if(doorway){spec.requirements=['An upright red doorway frame has two pillars and a horizontal lintel, with an empty central opening.'];spec.contract.runtime.lodTriangles=[60];}
const requestFile=path.join(root,'request.json'),reportFile=path.join(root,'report.json');
await atomicJson(requestFile,{assets:[{spec,requirementsHash:'probe',sourceHash:await hashFile(path.join(root,'model.fbx')),dccDimensions:probeDimensions,dccCollisionCount:doorway?3:1,import:{packagePath:'/Game/Probe/SM_Probe.SM_Probe',mapPath:'/Game/Probe/AssetTest'}}]});
const script=path.join(root,'probe.py');
await fs.writeFile(script,`import unreal as u,os,runpy\nroot=${JSON.stringify(root)}\nlevel=u.get_editor_subsystem(u.LevelEditorSubsystem)\nlevel.new_level('/Game/Probe/AssetTest')\ntask=u.AssetImportTask()\ntask.filename=os.path.join(root,'model.fbx')\ntask.destination_path='/Game/Probe'\ntask.destination_name='SM_Probe'\ntask.automated=True\ntask.replace_existing=True\ntask.save=True\noptions=u.FbxImportUI()\noptions.import_mesh=True\noptions.import_materials=True\noptions.import_textures=True\noptions.import_as_skeletal=False\noptions.automated_import_should_detect_type=False\noptions.mesh_type_to_import=u.FBXImportType.FBXIT_STATIC_MESH\noptions.static_mesh_import_data.combine_meshes=True\noptions.static_mesh_import_data.auto_generate_collision=True\noptions.static_mesh_import_data.normal_import_method=u.FBXNormalImportMethod.FBXNIM_IMPORT_NORMALS_AND_TANGENTS\ntask.options=options\nu.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])\nmesh=u.load_asset('/Game/Probe/SM_Probe.SM_Probe')\nassert isinstance(mesh,u.StaticMesh),task.imported_object_paths\nsm=u.get_editor_subsystem(u.StaticMeshEditorSubsystem) or u.get_default_object(u.StaticMeshEditorSubsystem)\nprint('COLLISION_BEFORE_LOD',sm.get_convex_collision_count(mesh))\nassert sm.import_lod(mesh,1,os.path.join(root,'lod1.fbx'))==1\nu.EditorAssetLibrary.save_loaded_asset(mesh)\nactors=u.get_editor_subsystem(u.EditorActorSubsystem)\nactor=actors.spawn_actor_from_class(u.StaticMeshActor,u.Vector(0,0,100))\nactor.static_mesh_component.set_static_mesh(mesh)\nlevel.save_current_level()\nu.SystemLibrary.execute_console_command(u.get_editor_subsystem(u.UnrealEditorSubsystem).get_editor_world(),'r.FinishCurrentFrame 1')\ncheck=runpy.run_path(${JSON.stringify(path.join(repositoryRoot,'worker/tools/modeling-unreal-check.py'))})\nresult=check['validate'](${JSON.stringify(requestFile)},${JSON.stringify(reportFile)})\nprint('UNREAL_MODELING_PROBE',result['passed'])\n`);
console.log(JSON.stringify({root,state:'unreal-started'}));
await command('unreal',process.env.UNREAL_CMD||'D:\\UE\\UE_5.8\\Engine\\Binaries\\Win64\\UnrealEditor-Cmd.exe',[projectFile,'-unattended','-nosplash','-nop4','-nosound','-AllowCommandletRendering','-run=pythonscript',`-script=${script}`],300000);
const report=await readJson(reportFile);
console.log(JSON.stringify({root,report}));
if(!report?.passed)process.exitCode=1;
else {
  // Exercise the production host boundary, including a fresh load and independent image review.
  const exportDir=path.join(root,'accepted');await fs.mkdir(exportDir,{recursive:true});
  await fs.copyFile(path.join(root,'model.fbx'),path.join(exportDir,'model.fbx'));
  await atomicJson(path.join(exportDir,'geometry-report.json'),{export:{dimensions:probeDimensions},source:{gates:[{id:'collision',actual:Array.from({length:doorway?3:1},(_,i)=>'UCX_SM_Probe_'+String(i).padStart(2,'0'))}]}});
  await atomicJson(path.join(root,'plan/modeling-engine-imports.json'),{protocol:2,assets:[{assetId:'probe',packagePath:'/Game/Probe/SM_Probe.SM_Probe',mapPath:'/Game/Probe/AssetTest'}]});
  const output=path.join(root,'host-check');await fs.mkdir(output,{recursive:true});
  const result=await validateUnrealModels({project:root,output,projectFile,unreal:process.env.UNREAL_CMD||'D:\\UE\\UE_5.8\\Engine\\Binaries\\Win64\\UnrealEditor-Cmd.exe',
    signal:controller.signal,invocation:codexInvocation([]),attempt:1,
    summary:{assets:[{assetId:'probe',requirementsHash:'probe',spec,contract:spec.contract,files:await Promise.all(['model.fbx','geometry-report.json'].map(async name=>({path:`accepted/${name}`,sha256:await hashFile(path.join(exportDir,name))})))}]},
    step:async(name,exe,args,timeoutMs,cwd,accepts,options={})=>{
      const r=await runCommand(exe,args,{...options,cwd,timeoutMs,signal:controller.signal,stdoutFile:path.join(output,name+'.stdout.log'),stderrFile:path.join(output,name+'.stderr.log')});
      if(!r.stopConfirmed||r.exitCode!==0||r.error||r.timedOut)throw new Error(`Host step failed: ${name}: ${r.stderr.slice(-1000)}`);return r;
    }});
  console.log(JSON.stringify(result));
}
