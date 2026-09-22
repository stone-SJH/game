"""Local GLB handoff for the pinned low-poly toolkit; no Unity exports or network calls."""
import json
from pathlib import Path
import bpy


def export_asset(obj, directory):
    directory = Path(directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.file.pack_all()
    bpy.ops.wm.save_as_mainfile(filepath=str(directory / 'source.blend'))
    bpy.ops.export_scene.gltf(filepath=str(directory / 'model.glb'), export_format='GLB', use_selection=True)
    manifest = {'objects': [{'name': obj.name, 'role': 'render-mesh', 'lod': 0}], 'rootObject': obj.name}
    (directory / 'asset-manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    return manifest
