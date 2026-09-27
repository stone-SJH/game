// Import a static benchmark asset into an isolated UE project; retained failures stay diagnostic.
import fs from 'node:fs/promises';
import path from 'node:path';
import { runCommand } from '../agent/process-runner.mjs';
import { atomicJson, readJson, localPath, hashFile, hashValue, repositoryRoot, agentEnvironment } from '../agent/modeling-io.mjs';
import { blenderExecutable } from '../agent/modeling-capabilities.mjs';
import { validateUnrealModels } from '../agent/modeling-unreal.mjs';
import { codexInvocation } from '../agent/production-harness.mjs';

if(![4,5,6].includes(process.argv.length))throw new Error('Usage: node modeling-unreal-asset-probe.mjs <source-project> <new-output> [frozen-traversal-registration.json] [retained-input-manifest.json]');
const sourceProject=path.resolve(process.argv[2]),project=path.resolve(process.argv[3]);
await fs.mkdir(project); // Never overwrite a previous independent run.
const output=path.join(project,'run');await fs.mkdir(output);
let sourceAsset,result,supplemental,provenance,failure,integrityFailure,inputFilesUnchanged=null;
try {
const summary=await readJson(path.join(sourceProject,'plan/modeling-results.json'));
const retainedFile=process.argv[5]?path.resolve(process.argv[5]):null;
const retained=retainedFile?await readJson(retainedFile):null;
if(retainedFile&&retained?.evidenceSource!=='retained-unaccepted')throw new Error('Retained manifest must explicitly identify unaccepted evidence');
sourceAsset=retained||summary?.assets?.find(a=>a.contract?.runtime.engine==='unreal'&&a.contract.runtime.profile==='fbx-static');
if(!sourceAsset)throw new Error('An accepted static FBX asset or explicit retained final manifest is required.');
const asset=structuredClone(sourceAsset);
asset.contract ||= asset.spec?.contract;asset.requirementsHash ||= hashValue(asset.spec);
if(asset.contract?.runtime.engine!=='unreal'||asset.contract.runtime.profile!=='fbx-static')throw new Error('A static FBX asset targeting Unreal is required');
const modelFile=asset.files.find(f=>f.path.endsWith('/model.fbx'));
if(!modelFile)throw new Error('The retained final has no FBX export');
const modelDir=path.dirname(modelFile.path);
provenance={evidenceSource:retained?'retained-unaccepted':'accepted-manifest',sourceProject,
 retainedManifest:retainedFile,retainedManifestHash:retainedFile?await hashFile(retainedFile):null,
 note:retained?'Supplemental checks cannot promote the failed original modeling task.':'Original accepted task remains unchanged.'};
await atomicJson(path.join(output,'provenance.json'),provenance);
// Copy the complete accepted manifest, not a directory crawl; check every input hash.
for(const file of asset.files){
 const input=await localPath(sourceProject,file.path,{existing:true});
 if(await hashFile(input)!==file.sha256)throw new Error('Accepted benchmark source changed.');
 const destination=await localPath(project,file.path);await fs.mkdir(path.dirname(destination),{recursive:true});await fs.copyFile(input,destination);
}
const controller=new AbortController();process.on('SIGINT',()=>controller.abort());
async function step(name,exe,args,timeoutMs,cwd=project,accepts,options={}){
 console.log(JSON.stringify({stage:name}));
 const r=await runCommand(exe,args,{...options,env:agentEnvironment(options.env||process.env),cwd,timeoutMs,signal:controller.signal,
  stdoutFile:path.join(output,name+'.stdout.log'),stderrFile:path.join(output,name+'.stderr.log')});
 if(!r.stopConfirmed)throw Object.assign(new Error(`${name}: Unconfirmed process stop`),{kind:'STOP_UNCONFIRMED',stopConfirmed:false,result:r});
 if(r.exitCode!==0||r.error||r.timedOut||r.canceled)throw Object.assign(new Error(`${name}: ${r.error||r.stderr.slice(-1500)||r.stdout.slice(-1500)}`),{result:r});return r;
}
if(process.argv[4]) {
 const registration=path.resolve(process.argv[4]),traversal=(await readJson(registration))?.traversal;
 if(!traversal)throw new Error('Missing frozen traversal contract');
 const originalRequirementsHash=asset.requirementsHash;
 asset.spec=structuredClone(asset.spec);asset.spec.contract.traversal=traversal;asset.contract=asset.spec.contract;
 asset.requirementsHash=hashValue({originalRequirementsHash,traversal});
 const specFile=path.join(output,'supplemental-spec.json'),report=path.join(output,'supplemental/geometry-report.json');
 await atomicJson(specFile,asset.spec);await fs.mkdir(path.dirname(report));
 await step('supplemental-dcc',blenderExecutable(),['--background','--factory-startup','--disable-autoexec','--python-exit-code','1',
  '--python',path.join(repositoryRoot,'worker/tools/modeling-asset-check.py'),'--','--directory',path.join(project,modelDir),'--spec',specFile,'--report',report,'--workspace',project],300000);
 const geometry=await readJson(report);
 if(!geometry?.source?.gates?.some(g=>g.id==='traversal'))throw new Error('Supplemental DCC traversal evidence is missing');
 const relative=path.relative(project,report).replaceAll('\\','/');
 asset.files=asset.files.filter(f=>!f.path.endsWith('/geometry-report.json'));
 asset.files.push({path:relative,sha256:await hashFile(report)});
 supplemental={registration,registrationHash:await hashFile(registration),originalRequirementsHash,requirementsHash:asset.requirementsHash,
  dccPassed:geometry.passed,traversal:geometry.source.gates.find(g=>g.id==='traversal'),report,
  note:'New traversal contract applied to a copied, unchanged asset. Original modeling result and contract remain intact.'};
 await atomicJson(path.join(output,'supplemental-dcc.json'),supplemental);
}
const lodScript=path.join(output,'export-lods.py');
await fs.writeFile(lodScript,`import bpy,json,sys,os\nsys.dont_write_bytecode=True\nsys.path.insert(0,${JSON.stringify(path.join(repositoryRoot,'worker/tools'))})\nfrom modeling_scene import load_scene,mesh_objects\nroot=${JSON.stringify(path.join(project,modelDir))}\nload_scene(os.path.join(root,'source.blend'))\nmanifest=json.load(open(os.path.join(root,'asset-manifest.json'),encoding='utf-8-sig'))\nfor lod in range(1,${asset.contract.runtime.lodTriangles.length+1}):\n bpy.ops.object.select_all(action='DESELECT')\n objects=mesh_objects(manifest,'lod',lod)\n assert objects,'Missing declared LOD'\n for obj in objects: obj.hide_set(False);obj.select_set(True)\n bpy.context.view_layer.objects.active=objects[0]\n bpy.ops.export_scene.fbx(filepath=os.path.join(${JSON.stringify(output)},'lod'+str(lod)+'.fbx'),use_selection=True,add_leaf_bones=False,bake_anim=False,mesh_smooth_type='FACE')\n`);
await step('export-declared-lods',blenderExecutable(),['--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',lodScript],120000);
const projectFile=path.join(project,'AssetProbe.uproject');
await atomicJson(projectFile,{FileVersion:3,EngineAssociation:'5.8',Plugins:[{Name:'PythonScriptPlugin',Enabled:true},{Name:'EditorScriptingUtilities',Enabled:true}]});
const importScript=path.join(output,'import.py');
await fs.writeFile(importScript,`import unreal as u,os\nlevel=u.get_editor_subsystem(u.LevelEditorSubsystem)\nlevel.new_level('/Game/Probe/AssetTest')\ntask=u.AssetImportTask()\ntask.filename=${JSON.stringify(path.join(project,modelDir,'model.fbx'))}\ntask.destination_path='/Game/Probe'\ntask.destination_name='SM_Asset'\ntask.automated=True\ntask.save=True\noptions=u.FbxImportUI()\noptions.import_mesh=True\noptions.import_materials=True\noptions.import_textures=True\noptions.import_as_skeletal=False\noptions.automated_import_should_detect_type=False\noptions.mesh_type_to_import=u.FBXImportType.FBXIT_STATIC_MESH\noptions.static_mesh_import_data.combine_meshes=True\noptions.static_mesh_import_data.auto_generate_collision=True\noptions.static_mesh_import_data.one_convex_hull_per_ucx=True\noptions.static_mesh_import_data.normal_import_method=u.FBXNormalImportMethod.FBXNIM_IMPORT_NORMALS_AND_TANGENTS\ntask.options=options\nu.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])\nmesh=u.load_asset('/Game/Probe/SM_Asset.SM_Asset')\nassert isinstance(mesh,u.StaticMesh),task.imported_object_paths\nsm=u.get_editor_subsystem(u.StaticMeshEditorSubsystem) or u.get_default_object(u.StaticMeshEditorSubsystem)\nfor lod in range(1,${asset.contract.runtime.lodTriangles.length+1}):\n assert sm.import_lod(mesh,lod,os.path.join(${JSON.stringify(output)},'lod'+str(lod)+'.fbx'))==lod\nu.EditorAssetLibrary.save_loaded_asset(mesh)\nactor=u.get_editor_subsystem(u.EditorActorSubsystem).spawn_actor_from_class(u.StaticMeshActor,u.Vector(0,0,0))\nactor.static_mesh_component.set_static_mesh(mesh)\nlevel.save_current_level()\n`);
const unreal=process.env.UNREAL_CMD||'D:\\UE\\UE_5.8\\Engine\\Binaries\\Win64\\UnrealEditor-Cmd.exe';
await step('import-actual-asset',unreal,[projectFile,'-unattended','-nosplash','-nop4','-nosound','-run=pythonscript',`-script=${importScript}`],300000);
await atomicJson(path.join(project,'plan/modeling-engine-imports.json'),{protocol:2,assets:[{assetId:asset.assetId,packagePath:'/Game/Probe/SM_Asset.SM_Asset',mapPath:'/Game/Probe/AssetTest'}]});
 result=await validateUnrealModels({summary:{assets:[asset]},project,output,unreal,projectFile,step,signal:controller.signal,invocation:codexInvocation([]),attempt:1});
 if(supplemental&&!supplemental.dccPassed)throw Object.assign(new Error('Supplemental DCC gate failed'),{kind:'TECHNICAL_GAP'});
} catch(error) {
 failure=error;
}
if(sourceAsset?.files) {
 try {
  for(const file of sourceAsset.files)if(await hashFile(await localPath(sourceProject,file.path,{existing:true}))!==file.sha256)throw new Error('Original asset differs from the frozen UE probe input');
  inputFilesUnchanged=true;
 } catch(error) {
  inputFilesUnchanged=false;integrityFailure=error.message;
  failure ||= Object.assign(error,{kind:'INPUT_INTEGRITY_ERROR'});
 }
}
if(failure) {
 await atomicJson(path.join(output,'probe-result.json'),{passed:false,kind:failure.kind||'INFRASTRUCTURE_ERROR',error:failure.message,
  stopConfirmed:failure.stopConfirmed??failure.result?.stopConfirmed??null,inputFilesUnchanged,integrityFailure,supplemental,provenance});
 throw failure;
}
await atomicJson(path.join(output,'probe-result.json'),{passed:true,result,supplemental,provenance,inputFilesUnchanged});console.log(JSON.stringify(result));
