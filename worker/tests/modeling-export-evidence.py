"""Run with Blender --background --python-exit-code 1 --python this_file."""
import sys
import tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'tools'))
import bpy
from modeling_export_evidence import inspect_fbx

bpy.ops.wm.read_factory_settings(use_empty=True)
entries = []
for name, role, lod in [('Panel', 'render-mesh', 0), ('Panel_LOD1', 'lod', 1), ('UCX_Panel_00', 'collision', 0)]:
    bpy.ops.mesh.primitive_cube_add()
    bpy.context.object.name = name
    entries.append({'name': name, 'role': role, 'lod': lod})
spec = {'contract': {'runtime': {'collision': 'convex', 'lodTriangles': [12]}}}
with tempfile.TemporaryDirectory(prefix='modeling-export-evidence-') as directory:
    good = inspect_fbx(spec, {'objects': entries}, directory)
    assert good['passed'], good
    assert good['collision']['count'] == 1
    assert len(good['views']) == 4
    assert good['views'][0]['camera'] == good['views'][2]['camera']
    assert good['views'][1]['camera'] == good['views'][3]['camera']
    bpy.data.objects['UCX_Panel_00'].name = 'UCX_Unrelated_00'
    entries[2]['name'] = 'UCX_Unrelated_00'
    bad_binding = inspect_fbx(spec, {'objects': entries}, directory)
    assert not bad_binding['passed'] and bad_binding['collision']['invalid'] == ['UCX_Unrelated_00']
    bpy.data.objects.remove(bpy.data.objects['UCX_Unrelated_00'], do_unlink=True)
    missing_collision = inspect_fbx(spec, {'objects': entries}, directory)
    assert not missing_collision['passed']
    bpy.data.objects.remove(bpy.data.objects['Panel_LOD1'], do_unlink=True)
    missing_lod = inspect_fbx(spec, {'objects': entries}, directory)
    assert missing_lod['missingLods'] == [{'lod': 1, 'missing': ['Panel_LOD1']}]
print('PASS: FBX collision bindings, missing proxies, missing LODs, and identical LOD cameras')
