"""Independent FBX proxy measurements and identical-camera LOD renders."""
from pathlib import Path
import bpy
from modeling_scene import mesh_objects, mesh_metrics, bounds_of, render_views


def inspect_fbx(spec, manifest, directory):
    entries = manifest['objects']
    base = mesh_objects(manifest)
    collisions = [bpy.context.scene.objects.get(e['name']) for e in entries if e['role'] == 'collision']
    invalid = [e['name'] for e in entries if e['role'] == 'collision' and
               (bpy.context.scene.objects.get(e['name']) is None or bpy.context.scene.objects[e['name']].type != 'MESH')]
    invalid += [o.name for o in collisions if o and o.type == 'MESH' and
                (not mesh_metrics(o, compute_convex=True)['convex'] or
                 not any(o.name.startswith('UCX_' + mesh.name + '_') for mesh in base))]
    requested = spec['contract']['runtime']['collision'] == 'convex'
    collision = {'status': ('PASS' if collisions and not invalid else 'GAP') if requested else 'NOT_APPLICABLE',
                 'count': len(collisions), 'invalid': invalid, 'proxies': [o.name for o in collisions if o],
                 'scope': 'Reimported FBX closed convex proxies and UCX target names; Unreal binding/sweeps are a later gate.'}
    views, missing = [], []
    if spec['contract']['runtime']['lodTriangles'] and base:
        framing = bounds_of(base)
        for lod in range(len(spec['contract']['runtime']['lodTriangles']) + 1):
            selected = [dict(e, role='render-mesh', lod=0) for e in entries
                        if (e['role'] == 'render-mesh' if lod == 0 else e['role'] == 'lod' and e['lod'] == lod)]
            absent = [e['name'] for e in selected if bpy.context.scene.objects.get(e['name']) is None]
            if not selected or absent:
                missing.append({'lod': lod, 'missing': absent or ['all meshes']})
                continue
            captures = render_views(Path(directory)/('lod'+str(lod)), ['front', 'perspective'],
                                    manifest={'objects': selected}, framing=framing)
            views.extend(dict(view, lod=lod, phase='fbx-reimport') for view in captures)
    elif spec['contract']['runtime']['lodTriangles']:
        missing.append({'lod': 0, 'missing': ['LOD0 meshes']})
    return {'passed': collision['status'] != 'GAP' and not missing, 'collision': collision,
            'missingLods': missing, 'views': views}
