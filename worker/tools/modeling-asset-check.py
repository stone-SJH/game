"""Independent Blender source/export checks and four standard-view renders."""
import argparse
import json
import math
import os
import sys
sys.dont_write_bytecode = True
from pathlib import Path

import bpy
import bmesh
from mathutils import Vector
sys.path.insert(0, str(Path(__file__).parent))


def inspect_scene(spec):
    objects = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
    triangles = 0
    degenerate = 0
    open_edges = 0
    finite = True
    material_slots = 0
    for obj in objects:
        evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
        mesh = evaluated.to_mesh()
        mesh.calc_loop_triangles()
        triangles += len(mesh.loop_triangles)
        finite = finite and all(math.isfinite(axis) for vert in mesh.vertices for axis in vert.co)
        bm = bmesh.new()
        bm.from_mesh(mesh)
        degenerate += sum(face.calc_area() <= 1e-12 for face in bm.faces)
        # glTF splits vertices at UV/normal seams; measure geometric closure after welding.
        bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-7)
        open_edges += sum(not edge.is_manifold for edge in bm.edges)
        bm.free()
        evaluated.to_mesh_clear()
        material_slots += len(obj.material_slots)
    missing_images = [image.name for image in bpy.data.images if image.source == 'FILE'
                      and not image.packed_file and not os.path.isfile(bpy.path.abspath(image.filepath))]
    textured = any(mat and mat.use_nodes and any(node.type == 'TEX_IMAGE' for node in mat.node_tree.nodes)
                   for obj in objects for mat in obj.data.materials)
    rigged = any(obj.type == 'ARMATURE' for obj in bpy.context.scene.objects)
    checks = {
        'hasMesh': bool(objects) and triangles > 0,
        'finiteCoordinates': finite,
        'triangleBudget': 0 < triangles <= spec['maxTriangles'],
        'noDegenerateFaces': degenerate == 0,
        'closedMeshRequirementMet': not spec['requireClosedMesh'] or open_edges == 0,
        'materialsPresent': material_slots > 0,
        'texturesAvailable': not missing_images,
        'texturedMeshesHaveUVs': not textured or all(bool(obj.data.uv_layers) for obj in objects),
        'rigRequirementMet': not spec['requireRig'] or (rigged and any(obj.vertex_groups for obj in objects)),
    }
    bounds = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
    dimensions = [max(point[axis] for point in bounds) - min(point[axis] for point in bounds)
                  for axis in range(3)] if bounds else [0, 0, 0]
    return {'passed': all(checks.values()), 'checks': checks, 'triangles': triangles,
            'degenerateFaces': degenerate, 'nonManifoldEdges': open_edges,
            'dimensions': dimensions, 'missingImages': missing_images}, bounds


def render_views(directory, bounds):
    if not bounds:
        return []
    scene = bpy.context.scene
    center = Vector(tuple((min(v[i] for v in bounds) + max(v[i] for v in bounds)) / 2 for i in range(3)))
    extent = max(max(v[i] for v in bounds) - min(v[i] for v in bounds) for i in range(3)) or 1
    for obj in list(scene.objects):
        if obj.type in {'CAMERA', 'LIGHT'}:
            bpy.data.objects.remove(obj, do_unlink=True)
    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x = 512
    scene.render.resolution_y = 512
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.film_transparent = False
    scene.world = bpy.data.worlds.new('ModelingQAWorld')
    scene.world.use_nodes = True
    scene.world.node_tree.nodes['Background'].inputs[0].default_value = (0.12, 0.12, 0.12, 1)
    scene.world.node_tree.nodes['Background'].inputs[1].default_value = 0.7
    for index, offset in enumerate([(2, -3, 4), (-3, -1, 2), (1, 3, 3)]):
        data = bpy.data.lights.new(f'QA-light-{index}', 'AREA')
        data.energy = 500 * extent * extent
        data.shape = 'DISK'
        data.size = extent * 3
        light = bpy.data.objects.new(data.name, data)
        scene.collection.objects.link(light)
        light.location = center + Vector(offset) * extent
        light.rotation_euler = (center - light.location).to_track_quat('-Z', 'Y').to_euler()
    camera_data = bpy.data.cameras.new('QA-camera')
    camera_data.type = 'ORTHO'
    camera_data.ortho_scale = extent * 1.8
    camera = bpy.data.objects.new('QA-camera', camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    previews = []
    for name, direction in [('front', (0, -1, 0)), ('side', (1, 0, 0)), ('back', (0, 1, 0)), ('perspective', (1, -1, 0.65))]:
        camera.location = center + Vector(direction).normalized() * extent * 4
        camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
        file = directory / f'{name}.png'
        scene.render.filepath = str(file)
        bpy.ops.render.render(write_still=True)
        previews.append(str(file))
    return previews


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory')
    parser.add_argument('--spec')
    parser.add_argument('--candidate')
    parser.add_argument('--report', required=True)
    parser.add_argument('--workspace')
    options = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
    if options.candidate:
        candidate = Path(options.candidate).resolve()
        bpy.ops.wm.read_factory_settings(use_empty=True)
        if candidate.suffix.lower() == '.blend':
            bpy.ops.wm.open_mainfile(filepath=str(candidate), load_ui=False, use_scripts=False)
        elif candidate.suffix.lower() == '.glb':
            bpy.ops.import_scene.gltf(filepath=str(candidate))
        elif candidate.suffix.lower() == '.fbx':
            bpy.ops.import_scene.fbx(filepath=str(candidate))
        else:
            raise ValueError('Unsupported candidate format')
        stats, bounds = inspect_scene({'maxTriangles': 2000000, 'requireClosedMesh': False, 'requireRig': False})
        previews = render_views(Path(options.report).parent, bounds)
        Path(options.report).write_text(json.dumps({'source': stats, 'previews': previews}, indent=2) + '\n', encoding='utf-8')
        return
    if not options.directory or not options.spec:
        parser.error('--directory and --spec are required for asset validation')
    directory = Path(options.directory).resolve()
    spec = json.loads(Path(options.spec).read_text(encoding='utf-8-sig'))
    if spec.get('contract'):
        from modeling_scene import load_scene, render_views as fixed_views, sha256, write_json
        from modeling_quality import check_scene
        from modeling_reference import compare
        manifest = json.loads((directory / 'asset-manifest.json').read_text(encoding='utf-8-sig'))
        load_scene(directory / 'source.blend')
        source = check_scene(spec, manifest)
        load_scene(directory / 'model.glb')
        exported = check_scene(spec, manifest, exported=True)
        view_names = ['front','side','back','top','perspective'] + (['other-side','bottom'] if spec['contract']['asymmetric'] else [])
        views = fixed_views(Path(options.report).parent, view_names)
        motion_views = []
        if spec['contract']['runtime']['animations'] and exported['passed']:
            from modeling_quality import animation_samples
            from modeling_scene import mesh_objects
            def render_motion(name, frame):
                # Use a hash for filenames; animation names are data, never path components.
                import hashlib
                tag = hashlib.sha256(name.encode()).hexdigest()[:16]
                motion_views.extend(fixed_views(Path(options.report).parent/'animations'/tag/str(frame), ['perspective']))
            animation_samples(spec['contract']['runtime']['animations'], mesh_objects(), render_motion)
        matches = []
        for match in spec['contract']['referenceMatches']:
            if not options.workspace:
                raise ValueError('Workspace required for reference matching')
            root = Path(options.workspace).resolve()
            reference = (root / match['mask']).resolve()
            if not reference.is_relative_to(root) or any(p.is_symlink() for p in [reference,*reference.parents] if p != root.parent):
                raise ValueError('Unsafe reference path')
            rendered = fixed_views(Path(options.report).parent,[match['view']],silhouette=True)[0]['file']
            matches.append({'image':match['image'],'mask':match['mask'],'maskHash':sha256(reference),
                            **compare(reference,rendered,match['minIoU'],match['maxAspectError'])})
        dependencies, dependency_errors = [], []
        if spec['contract']['runtime']['profile'].startswith('fbx'):
            load_scene(directory/'model.fbx')
            workspace = Path(options.workspace or directory).resolve()
            for im in bpy.data.images:
                if im.source != 'FILE' or im.packed_file:
                    continue
                file = Path(bpy.path.abspath(im.filepath)).resolve()
                if not file.is_relative_to(workspace) or not file.is_file():
                    dependency_errors.append(im.name)
                else:
                    dependencies.append({'file':str(file),'sha256':sha256(file)})
        write_json(options.report, {'protocol':2,'assetId':spec['assetId'],
            'passed':source['passed'] and exported['passed'] and not dependency_errors and all(m['status']=='PASS' for m in matches),
            'source':source,'export':exported,'views':views,'motionViews':motion_views,'referenceMatches':matches,
            'runtimeDependencies':dependencies,'missingRuntimeDependencies':dependency_errors,
            'sourceHash':sha256(directory/'source.blend'),'exportHash':sha256(directory/'model.glb'),
            'blenderVersion':bpy.app.version_string})
        return
    bpy.ops.wm.open_mainfile(filepath=str(directory / 'source.blend'), load_ui=False, use_scripts=False)
    source, _ = inspect_scene(spec)
    # Inspect the actual runtime interchange file too, not only the editable source.
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(directory / 'model.glb'))
    exported, bounds = inspect_scene(spec)
    previews = render_views(Path(options.report).parent, bounds)
    report = {'protocol': 1, 'assetId': spec['assetId'], 'passed': source['passed'] and exported['passed'],
              'source': source, 'export': exported, 'previews': previews, 'blenderVersion': bpy.app.version_string}
    Path(options.report).write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
