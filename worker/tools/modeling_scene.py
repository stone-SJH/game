"""Shared, deterministic Blender inspection and preview functions (no source writes)."""
import hashlib
import json
import math
from pathlib import Path
import bpy
import bmesh
from mathutils import Vector

VIEWS = {'front': (0, -1, 0), 'side': (1, 0, 0), 'back': (0, 1, 0),
         'top': (0, 0, 1), 'perspective': (1, -1, .65), 'other-side': (-1, 0, 0), 'bottom': (0, 0, -1)}


def sha256(file):
    digest = hashlib.sha256()
    with open(file, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def write_json(file, data):
    Path(file).parent.mkdir(parents=True, exist_ok=True)
    Path(file).write_text(json.dumps(data, indent=2, allow_nan=False) + '\n', encoding='utf-8')


def load_scene(file):
    file = Path(file).resolve()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if file.suffix.lower() == '.blend':
        bpy.ops.wm.open_mainfile(filepath=str(file), load_ui=False, use_scripts=False)
    elif file.suffix.lower() == '.glb':
        # Bone custom-shape meshes are editor UI, not geometry in the interchange file.
        bpy.ops.import_scene.gltf(filepath=str(file), disable_bone_shape=True)
    elif file.suffix.lower() == '.fbx':
        bpy.ops.import_scene.fbx(filepath=str(file))
    else:
        raise ValueError('Unsupported model format')


def mesh_objects(manifest=None, role='render-mesh', lod=0):
    objects = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    if manifest:
        names = {r['name'] for r in manifest['objects'] if r['role'] == role and r.get('lod', 0) == lod}
        objects = [o for o in objects if o.name in names]
    return objects


def bounds_of(objects):
    points = []
    graph = bpy.context.evaluated_depsgraph_get()
    for obj in objects:
        evaluated = obj.evaluated_get(graph)
        mesh = evaluated.to_mesh()
        points.extend(evaluated.matrix_world @ v.co for v in mesh.vertices)
        evaluated.to_mesh_clear()
    return points


def dimensions(points):
    return [max(p[a] for p in points) - min(p[a] for p in points) for a in range(3)] if points else [0, 0, 0]


def mesh_metrics(obj, compute_convex=False):
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = evaluated.to_mesh()
    mesh.calc_loop_triangles()
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-7)
    bm.normal_update()
    open_edges = sum(not e.is_manifold for e in bm.edges)
    convex = compute_convex and open_edges == 0 and bool(bm.faces) and abs(bm.calc_volume()) > 1e-12
    if convex:
        for face in bm.faces:
            offsets = [(v.co - face.verts[0].co).dot(face.normal) for v in bm.verts]
            if min(offsets) < -1e-6 and max(offsets) > 1e-6:
                convex = False
                break
    stats = {'triangles': len(mesh.loop_triangles), 'vertices': len(mesh.vertices),
             'inconsistentWindingEdges': sum(e.is_manifold and not e.is_contiguous for e in bm.edges),
             'inwardClosedVolume': open_edges == 0 and bool(bm.faces) and bm.calc_volume(signed=True) < -1e-12,
             'nonManifoldEdges': open_edges, 'degenerateFaces': sum(f.calc_area() <= 1e-12 for f in bm.faces),
             'looseVertices': sum(not v.link_faces for v in bm.verts), 'convex': convex,
             'finite': all(math.isfinite(x) for v in mesh.vertices for x in v.co) and
                       all(math.isfinite(x) for row in obj.matrix_world for x in row),
             'positiveScale': obj.matrix_world.determinant() > 0}
    bm.free()
    evaluated.to_mesh_clear()
    return stats


def inspect_scene(manifest=None):
    rows = []
    for obj in bpy.context.scene.objects:
        row = {'name': obj.name, 'type': obj.type, 'location': list(obj.location), 'scale': list(obj.scale)}
        if obj.type == 'MESH':
            row.update(mesh_metrics(obj))
            row.update(materials=[m.name if m else None for m in obj.data.materials],
                       uvLayers=[uv.name for uv in obj.data.uv_layers],
                       armatures=[m.object.name if m.object else None for m in obj.modifiers if m.type == 'ARMATURE'])
        rows.append(row)
    return {'blenderVersion': bpy.app.version_string, 'units': bpy.context.scene.unit_settings.scale_length,
            'dimensionsMeters': dimensions(bounds_of(mesh_objects(manifest))), 'objects': rows}


def render_views(directory, names, manifest=None, silhouette=False, size=512):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    objects = mesh_objects(manifest)
    points = bounds_of(objects)
    if not points:
        raise ValueError('No render geometry')
    center = Vector([(max(p[i] for p in points) + min(p[i] for p in points)) / 2 for i in range(3)])
    extent = max(dimensions(points)) or 1
    scene = bpy.context.scene
    for obj in list(scene.objects):
        if obj.type in {'CAMERA', 'LIGHT'}:
            bpy.data.objects.remove(obj, do_unlink=True)
        elif obj.type == 'MESH':
            obj.hide_render = obj not in objects
    # Authored compositor/world/exposure cannot hide a defect in host previews.
    scene.use_nodes = False
    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x = scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.film_transparent = silhouette
    scene.view_settings.view_transform = 'Standard' if silhouette else 'AgX'
    scene.view_settings.exposure = 0
    scene.view_settings.gamma = 1
    scene.world = bpy.data.worlds.new('QA-world')
    scene.world.use_nodes = True
    scene.world.node_tree.nodes['Background'].inputs[0].default_value = (.12, .12, .12, 1)
    scene.world.node_tree.nodes['Background'].inputs[1].default_value = .7
    if silhouette:
        mat = bpy.data.materials.new('QA-silhouette')
        mat.use_nodes = True
        nodes = mat.node_tree.nodes
        nodes.clear()
        emit = nodes.new('ShaderNodeEmission')
        emit.inputs['Color'].default_value = (1, 1, 1, 1)
        out = nodes.new('ShaderNodeOutputMaterial')
        mat.node_tree.links.new(emit.outputs[0], out.inputs['Surface'])
        for obj in objects:
            obj.data.materials.clear()
            obj.data.materials.append(mat)
            for poly in obj.data.polygons:
                poly.material_index = 0
    else:
        for i, offset in enumerate([(2, -3, 4), (-3, -1, 2), (1, 3, 3)]):
            light = bpy.data.objects.new('QA-light-' + str(i), bpy.data.lights.new('QA-light-data', 'AREA'))
            scene.collection.objects.link(light)
            light.data.energy, light.data.size = 500 * extent * extent, extent * 3
            light.location = center + Vector(offset) * extent
            light.rotation_euler = (center - light.location).to_track_quat('-Z', 'Y').to_euler()
    camera = bpy.data.objects.new('QA-camera', bpy.data.cameras.new('QA-camera-data'))
    scene.collection.objects.link(camera)
    camera.data.type, camera.data.ortho_scale = 'ORTHO', extent * 1.8
    camera.data.clip_start, camera.data.clip_end = max(.0001, extent * .001), max(100, extent * 20)
    scene.camera = camera
    result = []
    for name in names:
        direction = Vector(VIEWS[name])
        camera.location = center + direction.normalized() * extent * 4
        camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
        file = directory / (name + ('-mask' if silhouette else '') + '.png')
        scene.render.filepath = str(file)
        bpy.ops.render.render(write_still=True)
        result.append({'view': name, 'file': str(file), 'sha256': sha256(file),
                       'camera': {'location': list(camera.location), 'center': list(center), 'orthoScale': camera.data.ortho_scale}})
    return result
