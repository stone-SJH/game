import sys
from pathlib import Path
import runpy
sys.dont_write_bytecode=True
import bpy
root=Path(sys.argv[sys.argv.index('--')+1]);root.mkdir(parents=True,exist_ok=False)
tool=runpy.run_path(str(Path(__file__).resolve().parents[1]/'tools/modeling-reuse-diff.py'))
bpy.ops.wm.read_factory_settings(use_empty=True);bpy.ops.mesh.primitive_cube_add();obj=bpy.context.object
mat=bpy.data.materials.new('Red');mat.use_nodes=True;obj.data.materials.append(mat)
mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=(.6,.01,.01,1)
bpy.ops.wm.save_as_mainfile(filepath=str(root/'red.blend'))
obj.name='Renamed';mat.name='Blue';mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=(.01,.01,.6,1)
bpy.ops.wm.save_as_mainfile(filepath=str(root/'blue.blend'))
obj.data.vertices[0].co.x-=.2;bpy.ops.wm.save_as_mainfile(filepath=str(root/'reshaped.blend'))
same=tool['compare'](root/'red.blend',root/'red.blend');edit=tool['compare'](root/'red.blend',root/'blue.blend');shape=tool['compare'](root/'red.blend',root/'reshaped.blend')
assert same['geometryUnchanged'] and not same['materialsChanged']
assert edit['geometryUnchanged'] and edit['materialsChanged']
assert not shape['geometryUnchanged'] and shape['materialsChanged']
tool['write_json'](root/'report.json',{'passed':True,'cases':[same,edit,shape]})
print('REUSE_DIFF_PASS 3')
