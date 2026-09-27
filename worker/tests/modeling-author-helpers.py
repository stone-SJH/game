"""Run through the real Blender MCP; write host-readable evidence outside the repository."""
import json
import math
import sys
from pathlib import Path
sys.dont_write_bytecode = True
import bpy
from mathutils import Vector


def run(root, helper_directory, tools_directory):
    sys.path.insert(0, helper_directory); sys.path.insert(0, tools_directory)
    import yahaha_modeling as ym
    from modeling_scene import load_scene, write_json
    from modeling_quality import check_scene
    root=Path(root);root.mkdir(parents=True,exist_ok=True); rows=[]
    def record(name, condition, evidence=None):
        assert condition, (name,evidence)
        rows.append({'case':name,'passed':True,'evidence':evidence})
        write_json(root/'helper-report.json',{'passed':False,'blenderVersion':bpy.app.version_string,'cases':rows})
    bpy.ops.wm.read_factory_settings(use_empty=True)
    record('null-world',bpy.context.scene.world is None)
    record('ensure-world',ym.ensure_world() is not None)
    ym.set_render_engine('BLENDER_EEVEE');record('render-enum',bpy.context.scene.render.engine=='BLENDER_EEVEE')
    try:ym.set_render_engine('NOT_AN_ENGINE');raise AssertionError('invalid engine accepted')
    except ValueError:record('invalid-render-enum',True)
    file=ym.workspace_path(root,'中文 空格/recipe.json');file.parent.mkdir();file.write_text('\ufeff{"message":"中文"}',encoding='utf-8')
    record('bom-path',ym.read_json(file)['message']=='中文')
    try:ym.workspace_path(root,'../outside.json');raise AssertionError('escape accepted')
    except ValueError:record('path-escape',True)
    bpy.ops.mesh.primitive_cube_add(size=1,location=(0,0,1));obj=bpy.context.object;obj.name='SM_Moving'
    obj['values']=[1.,2.,3.];ym.write_json(root/'safe.json',{'vector':Vector((1,2,3)),'properties':obj})
    record('safe-vector-idproperty',ym.read_json(root/'safe.json')['properties']['values']==[1,2,3])
    try:ym.write_json(root/'nonfinite.json',{'x':float('nan')});raise AssertionError('nonfinite accepted')
    except ValueError:record('nonfinite-rejected',True)
    obj.data.materials.append(ym.pbr_material('Red',(.6,.01,.01,1)))
    bpy.ops.object.armature_add();rig=bpy.context.object;rig.name='Rig'
    obj.vertex_groups.new(name='Bone').add(list(range(len(obj.data.vertices))),1,'REPLACE');obj.modifiers.new('Binding','ARMATURE').object=rig
    action=ym.bone_action(rig,'Wave',{'Bone':[(1,(0,0,0)),(12,(.6,0,0)),(24,(0,0,0))]})
    record('layered-action',bool(action.layers) and len(ym.action_channels(action,rig.animation_data.action_slot))==3)
    try:ym.bone_action(rig,'Wave',{});raise AssertionError('duplicate action silently renamed')
    except ValueError:record('duplicate-action-rejected',True)
    bpy.context.scene.frame_set(1);motion=ym.measure_motion([obj],[1,12,24]);record('evaluated-motion',motion['moving'],motion)
    obj.modifiers[0].show_viewport=False;motion=ym.measure_motion([obj],[1,12,24]);record('unbound-motion-rejected',not motion['moving'],motion);obj.modifiers[0].show_viewport=True
    bpy.ops.mesh.primitive_cube_add(size=.1,location=(3,0,0));helper=bpy.context.object;helper.name='Hidden_Helper';helper.hide_set(True)
    manifest={'rootObject':rig.name,'objects':[{'name':obj.name,'role':'render-mesh','lod':0},{'name':helper.name,'role':'helper','lod':0}]}
    spec={'assetId':'helper-rig','requirements':['One red bound mesh moves'],'referenceImages':[],'maxTriangles':1000,'requireRig':True,'requireClosedMesh':True,
      'contract':{'version':2,'assetClass':'skeletal-character','styleProfile':'general','asymmetric':False,'referenceMatches':[],
        'dimensions':{'meters':None,'toleranceMeters':.01},'pivot':{'mode':'unknown','meters':None,'toleranceMeters':.01},
        'budgets':{'materials':3,'maxTextureSize':1024,'textureBytes':8388608},
        'runtime':{'engine':'none','profile':'fbx-skeletal','collision':'none','lodTriangles':[],'sockets':[],'animations':['Wave'],'lightmapUV':False}}}
    directory=root/'rig';ym.export_asset(directory,manifest,fbx=True);bpy.ops.wm.save_as_mainfile(filepath=str(directory/'source.blend'));ym.write_json(directory/'asset-manifest.json',manifest)
    record('export-restores-helper-visibility',helper.hide_get())
    source=check_scene(spec,manifest);record('rig-source-gates',source['passed'],source)
    load_scene(directory/'model.glb');exported=check_scene(spec,manifest,exported=True);record('rig-export-gates',exported['passed'],exported)
    meshes=[o for o in bpy.context.scene.objects if o.type=='MESH'];record('glb-role-selection',len(meshes)==1 and meshes[0].name=='SM_Moving')
    color=meshes[0].data.materials[0].node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value
    record('constant-color-roundtrip',abs(color[0]-.6)<.01 and color[1]<.02,list(color))
    record('fbx-written',(directory/'model.fbx').stat().st_size>1000)
    bpy.ops.wm.read_factory_settings(use_empty=True);bpy.ops.mesh.primitive_cube_add();obj=bpy.context.object;obj.name='SM_Baked'
    mat=ym.pbr_material('Procedural');obj.data.materials.append(mat);nodes=mat.node_tree.nodes
    noise=nodes.new('ShaderNodeTexNoise');ramp=nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].color=(.12,.025,.008,1);ramp.color_ramp.elements[1].color=(.6,.2,.035,1)
    mat.node_tree.links.new(noise.outputs['Fac'],ramp.inputs[0]);mat.node_tree.links.new(ramp.outputs['Color'],nodes.get('Principled BSDF').inputs['Base Color'])
    record('procedural-color-detected',bool(ym.base_color_issues([obj])))
    manifest={'rootObject':obj.name,'objects':[{'name':obj.name,'role':'render-mesh','lod':0}]}
    try:ym.export_asset(root/'unsafe',manifest);raise AssertionError('procedural color exported silently')
    except ValueError:record('procedural-export-refused',True)
    image=ym.bake_base_color(obj,root/'bake 中文'/'color.png',size=64);before=list(image.pixels[:]);size=list(image.size)
    record('packed-bake',image.packed_file is not None and not ym.base_color_issues([obj]))
    ym.export_asset(root/'baked',manifest);load_scene(root/'baked'/'model.glb')
    mat=next(o for o in bpy.context.scene.objects if o.type=='MESH').data.materials[0]
    imported=mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].links[0].from_node.image;pixels=list(imported.pixels[:])
    error=max(abs(a-b) for a,b in zip(before,pixels)) if len(before)==len(pixels) else math.inf
    record('baked-color-roundtrip',list(imported.size)==size and error<.02,{'size':size,'maxPixelDifference':error})
    record('baked-brown-pixels',any(pixels[i]>pixels[i+1]*1.5 and pixels[i+1]>pixels[i+2]*1.5 for i in range(0,len(pixels),4)))
    write_json(root/'helper-report.json',{'passed':True,'blenderVersion':bpy.app.version_string,'cases':rows})
