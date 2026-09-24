"""Versioned technical gates. Every required but unmeasured property remains GAP."""
import math
import bpy
from modeling_scene import bounds_of, dimensions, mesh_metrics, mesh_objects
from modeling_traversal import check_traversal

VERSION = '2.1.0'


def animation_samples(names, objects, render=None):
    """Measure actual evaluated vertices at three poses, restoring animation state afterwards."""
    arms = {m.object for obj in objects for m in obj.modifiers if m.type == 'ARMATURE' and m.object}
    saved = [(a, a.animation_data.action if a.animation_data else None,
              a.animation_data.action_slot if a.animation_data else None) for a in arms]
    frame = bpy.context.scene.frame_current
    rows = []
    try:
        for name in names:
            action = bpy.data.actions.get(name)
            row = {'action': name, 'frames': [], 'maxVertexDisplacementMeters': 0, 'passed': False}
            if action and arms:
                for arm in arms:
                    arm.animation_data_create().action = action
                    if action.slots:
                        arm.animation_data.action_slot = action.slots[0]
                start, end = action.frame_range
                frames = sorted(set(round(start + (end-start)*fraction) for fraction in [0, .5, 1]))
                baseline = None
                for value in frames:
                    bpy.context.scene.frame_set(value)
                    points = bounds_of(objects)
                    if baseline is None:
                        baseline = points
                    if len(points) == len(baseline):
                        row['maxVertexDisplacementMeters'] = max(row['maxVertexDisplacementMeters'], max(
                            ((a-b).length for a,b in zip(points,baseline)), default=0))
                    row['frames'].append(value)
                    if render:
                        render(name, value)
                row['passed'] = len(frames) > 1 and row['maxVertexDisplacementMeters'] > 1e-5
            rows.append(row)
    finally:
        for arm, action, slot in saved:
            arm.animation_data.action = action
            if slot:
                arm.animation_data.action_slot = slot
        bpy.context.scene.frame_set(frame)
    return rows


def check_scene(spec, manifest, exported=False):
    c = spec['contract']
    gates = []

    def gate(key, passed, expected, actual, tolerance=None, applicable=True):
        gates.append({'id': key, 'status': ('PASS' if passed else 'GAP') if applicable else 'NOT_APPLICABLE',
                      'expected': expected, 'actual': actual, 'tolerance': tolerance, 'validatorVersion': VERSION})

    all_meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    entries = manifest.get('objects', [])
    valid_manifest = bool(entries) and len({e.get('name') for e in entries}) == len(entries)
    valid_manifest &= all(e.get('role') in ['render-mesh', 'lod', 'collision', 'helper'] and
                          isinstance(e.get('lod', 0), int) and e.get('lod', 0) >= 0 for e in entries)
    if exported:
        # GLB contains LOD0 render meshes only; metadata is checked on the editable source.
        objects = all_meshes
    else:
        valid_manifest &= isinstance(manifest.get('rootObject'), str) and manifest['rootObject'] in bpy.context.scene.objects
        valid_manifest &= all(o.name in {e.get('name') for e in entries} for o in all_meshes)
        valid_manifest &= all(e.get('name') in bpy.context.scene.objects for e in entries)
        objects = mesh_objects(manifest) if valid_manifest else []
        gate('objectRoles', valid_manifest, 'Every mesh assigned exactly one declared role', len(entries))
    gate('hasMesh', bool(objects), 'LOD0 mesh', len(objects))
    stats = [mesh_metrics(o) for o in objects]
    tris = sum(s['triangles'] for s in stats)
    gate('triangleBudget', 0 < tris <= spec['maxTriangles'], spec['maxTriangles'], tris)
    gate('finiteCoordinates', all(s['finite'] for s in stats), True, all(s['finite'] for s in stats))
    gate('positiveScale', all(s['positiveScale'] for s in stats), True, all(s['positiveScale'] for s in stats))
    gate('degenerateFaces', not any(s['degenerateFaces'] for s in stats), 0, sum(s['degenerateFaces'] for s in stats))
    gate('looseVertices', not any(s['looseVertices'] for s in stats), 0, sum(s['looseVertices'] for s in stats))
    normal_errors = [o.name for o,s in zip(objects,stats) if s['inconsistentWindingEdges'] or s['inwardClosedVolume']]
    gate('normals', not normal_errors, 'Consistent face winding and outward closed surfaces', normal_errors)
    gate('closedMesh', not any(s['nonManifoldEdges'] for s in stats), 0,
         sum(s['nonManifoldEdges'] for s in stats), applicable=spec['requireClosedMesh'])
    points = bounds_of(objects)
    dims = dimensions(points)
    target = c['dimensions']['meters']
    tol = c['dimensions']['toleranceMeters']
    gate('dimensions', target is not None and all(abs(a-b) <= tol for a, b in zip(dims, target)), target, dims, tol, target is not None)
    # V2 recipes author in meter coordinates. Exporters must not apply unit scale twice.
    gate('meterUnits', abs(bpy.context.scene.unit_settings.scale_length - 1) <= 1e-6, 1,
         bpy.context.scene.unit_settings.scale_length, 1e-6)
    root = bpy.context.scene.objects.get(manifest.get('rootObject', ''))
    pivot = list(root.matrix_world.translation) if root else None
    mode = c['pivot']['mode']
    wanted = c['pivot']['meters']
    if points and mode in ['center', 'base-center']:
        wanted = [(max(p[i] for p in points) + min(p[i] for p in points))/2 for i in range(3)]
        if mode == 'base-center':
            wanted[2] = min(p.z for p in points)
    gate('pivot', bool(pivot is not None and wanted is not None and all(abs(a-b) <= c['pivot']['toleranceMeters'] for a,b in zip(pivot,wanted))),
         wanted, pivot, c['pivot']['toleranceMeters'], mode != 'unknown')
    materials = {m for o in objects for m in o.data.materials if m}
    invalid_materials = [o.name for o in objects if not o.data.materials or any(
        p.material_index >= len(o.data.materials) or o.data.materials[p.material_index] is None for p in o.data.polygons)]
    gate('materialsAssigned', not invalid_materials, 'Every face has a material', invalid_materials)
    gate('materialBudget', len(materials) <= c['budgets']['materials'], c['budgets']['materials'], len(materials))
    textures = set()
    uv_errors = []
    for obj in objects:
        textured_slots = set()
        for i, mat in enumerate(obj.data.materials):
            if mat and mat.use_nodes:
                images = [n.image for n in mat.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image]
                if images:
                    textured_slots.add(i)
                    textures.update(images)
        if textured_slots:
            uv = obj.data.uv_layers.active
            if not uv or not all(math.isfinite(x) for v in uv.data for x in v.uv):
                uv_errors.append(obj.name)
            elif c['styleProfile'] != 'lowpoly':
                for face in obj.data.polygons:
                    if face.material_index not in textured_slots:
                        continue
                    coords = [uv.data[i].uv for i in face.loop_indices]
                    area = abs(sum(a.x*b.y-b.x*a.y for a,b in zip(coords,coords[1:]+coords[:1])))*.5
                    if area <= 1e-12:
                        uv_errors.append(obj.name)
                        break
    gate('texturedUV', not uv_errors, 'Finite usable UVs on textured faces', uv_errors)
    missing = []
    for im in textures:
        try:
            # Packed/imported images are loaded lazily. Request pixels before testing has_data.
            readable = len(im.pixels) > 0 and min(im.size) > 0 and all(math.isfinite(v) for v in im.pixels[:4])
        except (RuntimeError, OSError):
            readable = False
        if not readable:
            missing.append(im.name)
    gate('texturesReadable', not missing, 'Readable texture pixels', missing)
    largest = max([max(im.size) for im in textures] or [0])
    memory = sum(im.size[0]*im.size[1]*4*(4 if im.is_float else 1) for im in textures)
    gate('textureResolution', largest <= c['budgets']['maxTextureSize'], c['budgets']['maxTextureSize'], largest)
    gate('textureMemory', memory <= c['budgets']['textureBytes'], c['budgets']['textureBytes'], memory)
    # Unsupported lightmap packing is an explicit gap until the target importer validates it.
    gate('lightmapUV', False, 'Measured padding and non-overlap', 'not calibrated', applicable=c['runtime']['lightmapUV'])
    rig_errors = []
    if spec['requireRig']:
        for obj in objects:
            arms = [m.object for m in obj.modifiers if m.type == 'ARMATURE' and m.object and m.object.type == 'ARMATURE']
            bone_names = {b.name for arm in arms for b in arm.data.bones if b.use_deform}
            groups = {g.index for g in obj.vertex_groups if g.name in bone_names}
            if not arms or not groups or any(abs(sum(g.weight for g in v.groups if g.group in groups)-1) > .01 for v in obj.data.vertices):
                rig_errors.append(obj.name)
    gate('rigBinding', bool(objects) and not rig_errors, 'Bound deform bones and normalized weights', rig_errors, .01, spec['requireRig'])
    actions = [a.name for a in bpy.data.actions]
    required_actions = c['runtime']['animations']
    gate('animationActions', all(a in actions for a in required_actions), required_actions, actions, applicable=bool(required_actions))
    motion = animation_samples(required_actions, objects) if required_actions else []
    gate('animationDeformation', all(r['passed'] for r in motion), 'Required actions visibly move bound vertices', motion,
         applicable=bool(required_actions))
    if not exported:
        collision = [bpy.context.scene.objects.get(e['name']) for e in entries if e.get('role') == 'collision']
        collision_ok = bool(collision) and all(o and o.type == 'MESH' and any(o.name.startswith('UCX_'+mesh.name+'_') for mesh in objects)
                                             and mesh_metrics(o, compute_convex=True)['convex'] for o in collision)
        gate('collision', collision_ok, 'Closed convex UCX proxies', [o.name for o in collision if o], applicable=c['runtime']['collision'] == 'convex')
        traversal = {'status': 'NOT_REQUESTED', 'paths': []}
        if c.get('traversal'):
            root_supported = bool(root) and all(abs(v-1) < 1e-6 for v in root.matrix_world.to_scale()) and root.matrix_world.determinant() > 0
            root_supported = root_supported and abs(root.matrix_world.to_3x3().col[2].z-1) < 1e-6
            if collision_ok and root_supported:
                # Contracts are expressed relative to the declared asset root, in meters.
                inverse = root.matrix_world.inverted()
                colliders = [(o.name,[tuple(inverse @ p) for p in bounds_of([o])]) for o in collision]
                try:
                    traversal = check_traversal(c['traversal'],colliders)
                    traversal['colliders'] = [{'name': name, 'verticesMeters': vertices} for name,vertices in colliders]
                except (ValueError, ArithmeticError) as exc:
                    traversal = {'status': 'GAP', 'reason': str(exc), 'paths': []}
            else:
                traversal = {'status': 'GAP', 'reason': 'Valid convex collision and upright unit-scale asset root required', 'paths': []}
        gates.append({'id': 'traversal', 'status': traversal['status'], 'expected': c.get('traversal'),
                      'actual': traversal, 'validatorVersion': VERSION})
        for i, budget in enumerate(c['runtime']['lodTriangles'], 1):
            lods = mesh_objects(manifest, 'lod', i)
            lod_stats = [mesh_metrics(o) for o in lods]
            count = sum(s['triangles'] for s in lod_stats)
            topology_ok = all(s['finite'] and s['positiveScale'] and not s['degenerateFaces'] and not s['inconsistentWindingEdges'] and not s['inwardClosedVolume'] for s in lod_stats)
            lod_dims = dimensions(bounds_of(lods))
            origins_ok = all(any((o.matrix_world.translation-base.matrix_world.translation).length <= c['pivot']['toleranceMeters'] for base in objects) for o in lods)
            gate('lod'+str(i), bool(lods) and topology_ok and origins_ok and 0 < count <= budget and all(abs(a-b) <= max(tol,abs(b)*.05) for a,b in zip(lod_dims,dims)),
                 {'triangles': budget, 'dimensions': dims}, {'triangles': count, 'dimensions': lod_dims})
        names = [o.name for o in bpy.context.scene.objects if o.type == 'EMPTY']
        gate('sockets', all(n in names or 'SOCKET_'+n in names for n in c['runtime']['sockets']), c['runtime']['sockets'], names,
             applicable=bool(c['runtime']['sockets']))
    return {'passed': all(g['status'] != 'GAP' for g in gates), 'gates': gates, 'triangles': tris,
            'dimensions': dims, 'validatorVersion': VERSION}
