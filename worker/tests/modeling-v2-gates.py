"""Real Blender defect injection; run with --python ... -- --out <task directory>."""
import argparse
import copy
import json
import sys
from pathlib import Path
sys.dont_write_bytecode = True
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
import bpy
from modeling_quality import check_scene
from modeling_reference import compare
from modeling_scene import write_json

p=argparse.ArgumentParser();p.add_argument('--out',required=True)
a=p.parse_args(sys.argv[sys.argv.index('--')+1:]);root=Path(a.out);root.mkdir(parents=True,exist_ok=True)
base={'assetId':'meter','maxTriangles':1000,'requireClosedMesh':True,'requireRig':False,'contract':{
 'version':2,'assetClass':'static-prop','styleProfile':'general','dimensions':{'meters':[1,1,1],'toleranceMeters':.001},
 'pivot':{'mode':'center','meters':None,'toleranceMeters':.001},'budgets':{'materials':2,'maxTextureSize':1024,'textureBytes':8388608},
 'runtime':{'engine':'none','profile':'glb-static','collision':'none','lodTriangles':[],'sockets':[],'animations':[],'lightmapUV':False},
 'referenceMatches':[],'asymmetric':False}}
manifest={'objects':[{'name':'SM_Meter','role':'render-mesh','lod':0}],'rootObject':'SM_Meter'}
def scene():
 bpy.ops.wm.read_factory_settings(use_empty=True);bpy.ops.mesh.primitive_cube_add(size=1)
 obj=bpy.context.object;obj.name='SM_Meter'
 mat=bpy.data.materials.new('Red');mat.use_nodes=True;mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=(.6,.02,.01,1)
 obj.data.materials.append(mat);return obj,copy.deepcopy(base)
records=[]
def run(name,spec,want,layout=manifest):
 bpy.context.view_layer.update();r=check_scene(spec,layout);gaps=[g['id'] for g in r['gates'] if g['status']=='GAP']
 assert (not gaps if want is None else want in gaps),(name,gaps)
 records.append({'case':name,'passed':True,'expectedGap':want,'actualGaps':gaps})
obj,spec=scene();run('valid-meter',spec,None)
obj.scale.x=2;run('wrong-dimensions',spec,'dimensions')
obj,spec=scene()
import bmesh
bm=bmesh.new();bm.from_mesh(obj.data);bmesh.ops.reverse_faces(bm,faces=list(bm.faces));bm.to_mesh(obj.data);bm.free()
run('inward-facing-closed-mesh',spec,'normals')
obj,spec=scene();obj.data.materials.clear();run('missing-material',spec,'materialsAssigned')
obj,spec=scene();mat=obj.data.materials[0];node=mat.node_tree.nodes.new('ShaderNodeTexImage');node.image=bpy.data.images.new('Tex',16,16)
obj.data.uv_layers.remove(obj.data.uv_layers.active);run('missing-uv',spec,'texturedUV')
obj,spec=scene();spec['requireRig']=True;bpy.ops.object.armature_add();obj.vertex_groups.new(name='unrelated');run('fake-rig',spec,'rigBinding')
obj,spec=scene();spec['requireRig']=True;bpy.ops.object.armature_add();arm=bpy.context.object
group=obj.vertex_groups.new(name='Bone');group.add(list(range(len(obj.data.vertices))),1,'REPLACE')
obj.modifiers.new('Rig','ARMATURE').object=arm
spec['contract']['runtime']['animations']=['Wave']
bone=arm.pose.bones['Bone'];bone.rotation_mode='XYZ'
bone.keyframe_insert(data_path='rotation_euler',frame=1)
bone.rotation_euler.x=.5;bone.keyframe_insert(data_path='rotation_euler',frame=10)
arm.animation_data.action.name='Wave';bpy.context.scene.frame_set(1)
run('bound-rig-with-measured-action',spec,None)
bone.rotation_euler.x=0;bone.keyframe_insert(data_path='rotation_euler',frame=10);bpy.context.scene.frame_set(1)
run('named-action-without-deformation',spec,'animationDeformation')
obj,spec=scene();obj.scale.x=-1;run('negative-scale',spec,'positiveScale')
obj,spec=scene();spec['contract']['runtime']['lightmapUV']=True;run('unsupported-required-lightmap',spec,'lightmapUV')
obj,spec=scene();bpy.ops.mesh.primitive_cube_add(size=1);collision=bpy.context.object;collision.name='UCX_SM_Meter_00'
layout=copy.deepcopy(manifest);layout['objects'].append({'name':collision.name,'role':'collision','lod':0});spec['contract']['runtime']['collision']='convex'
run('convex-helper-excluded-from-material-budget',spec,None,layout)
obj,spec=scene();bpy.ops.mesh.primitive_plane_add();run('undeclared-mesh',spec,'objectRoles')
obj,spec=scene();mat=obj.data.materials[0];node=mat.node_tree.nodes.new('ShaderNodeTexImage');node.image=bpy.data.images.new('Palette',16,16)
for uv in obj.data.uv_layers.active.data:uv.uv=(.5,.5)
run('degenerate-texture-uv',spec,'texturedUV');spec['contract']['styleProfile']='lowpoly';run('palette-uv-intentional',spec,None)
bpy.ops.wm.save_as_mainfile(filepath=str(root/'packed.blend'));bpy.ops.wm.open_mainfile(filepath=str(root/'packed.blend'),use_scripts=False)
run('lazy-loaded-packed-texture',spec,None)
for name,wide in [('square',False),('wide',True)]:
 im=bpy.data.images.new(name,32,32,alpha=False);pixels=[]
 for y in range(32):
  for x in range(32):
   value=1.0 if (4<=x<28 and (12<=y<20 if wide else 4<=y<28)) else 0.0
   pixels.extend([value,value,value,1])
 im.pixels=pixels;im.filepath_raw=str(root/(name+'.png'));im.file_format='PNG';im.save()
same=compare(root/'square.png',root/'square.png',.99,.01);different=compare(root/'square.png',root/'wide.png',.9,.03)
assert same['status']=='PASS' and different['status']=='GAP'
records.append({'case':'reference-aspect-mismatch','passed':True,'same':same,'different':different})
write_json(root/'gates-report.json',{'passed':True,'blenderVersion':bpy.app.version_string,'cases':records})
print('V2_GATE_RESULTS '+json.dumps({'passed':True,'cases':len(records),'report':str(root/'gates-report.json')}))
