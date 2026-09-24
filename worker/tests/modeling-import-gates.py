"""Exercise the real glTF importer, including genuine meshes named like editor helpers."""
import argparse
import copy
import json
import sys
from pathlib import Path
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import bpy
from modeling_scene import load_scene, sha256, write_json
from modeling_quality import check_scene

parser = argparse.ArgumentParser()
parser.add_argument('--out', required=True)
parser.add_argument('--retained-root')
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
root = Path(args.out); root.mkdir(parents=True, exist_ok=True)
spec = {'assetId': 'rig-fixture', 'maxTriangles': 1000, 'requireRig': True, 'requireClosedMesh': True,
        'contract': {'version': 2, 'assetClass': 'skeletal-character', 'styleProfile': 'general',
                     'dimensions': {'meters': None, 'toleranceMeters': .01}, 'pivot': {'mode': 'unknown', 'meters': None, 'toleranceMeters': .01},
                     'budgets': {'materials': 2, 'maxTextureSize': 1024, 'textureBytes': 8388608},
                     'runtime': {'engine': 'none', 'profile': 'fbx-skeletal', 'collision': 'none', 'lodTriangles': [],
                                 'sockets': [], 'animations': ['Wave'], 'lightmapUV': False}, 'referenceMatches': [], 'asymmetric': False}}
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 1))
obj = bpy.context.object; obj.name = 'Icosphere'
mat = bpy.data.materials.new('Red'); mat.use_nodes = True
obj.data.materials.append(mat)
bpy.ops.object.armature_add(); arm = bpy.context.object
obj.vertex_groups.new(name='Bone').add(list(range(len(obj.data.vertices))), 1, 'REPLACE')
obj.modifiers.new('Rig', 'ARMATURE').object = arm
bone = arm.pose.bones['Bone']; bone.rotation_mode = 'XYZ'
bone.keyframe_insert(data_path='rotation_euler', frame=1)
bone.rotation_euler.x = .5; bone.keyframe_insert(data_path='rotation_euler', frame=10)
arm.animation_data.action.name = 'Wave'; bpy.context.scene.frame_set(1)
model = root / 'genuine-Icosphere.glb'
bpy.ops.export_scene.gltf(filepath=str(model), export_format='GLB')
records = []
def check(name, required_gap=None):
    result = check_scene(spec, {}, exported=True)
    gaps = [g['id'] for g in result['gates'] if g['status'] == 'GAP']
    assert (required_gap in gaps if required_gap else not gaps), (name, gaps)
    records.append({'case': name, 'passed': True, 'gaps': gaps})

before = sha256(model)
load_scene(model)
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
assert len(meshes) == 1 and meshes[0].name == 'Icosphere'
check('genuine-Icosphere-valid')
meshes[0].hide_render = True; meshes[0].hide_viewport = True
meshes[0].data.materials.clear(); check('hidden-genuine-Icosphere-missing-material', 'materialsAssigned')
load_scene(model); bpy.data.objects['Icosphere'].modifiers.clear(); check('genuine-Icosphere-unbound', 'rigBinding')
load_scene(model)
spec['contract']['runtime']['animations'] = ['MissingAction']; check('missing-required-action', 'animationActions')
spec['contract']['runtime']['animations'] = ['Wave']
assert sha256(model) == before

if args.retained_root:
    for sample in ['rig-2', 'rig-3']:
        project = Path(args.retained_root) / '06-rig' / sample / 'project'
        spec = json.loads((project / 'plan/modeling-specs.json').read_text(encoding='utf-8-sig'))['assets'][0]
        models = sorted(project.glob('art/models/rig/*/blender_direct-*/model.glb'))
        assert len(models) == 3, (sample, models)
        for model in models:
            before = sha256(model); load_scene(model)
            check(f'{sample}/{model.parent.name}')
            assert sha256(model) == before
            records[-1].update(file=str(model), sha256=before)
write_json(root / 'import-gates-report.json', {'passed': True, 'blenderVersion': bpy.app.version_string, 'cases': records})
print('IMPORT_GATE_RESULTS ' + json.dumps({'passed': True, 'cases': len(records)}))
