"""Measure frozen paths in host-reviewed assembly poses using actual Blender geometry."""
import math
import bpy
from mathutils import Vector
from modeling_scene import bounds_of
from modeling_traversal import check_traversal


def measure_states(traversal, collision, root, record):
    if record.get('approval', {}).get('approved') is not True:
        raise ValueError('Traversal poses require host approval')
    states = record['plan']['states']
    paths = {row['id']: row for row in traversal['paths']}
    if sorted(row['pathId'] for row in states) != sorted(paths):
        raise ValueError('Pose plan must cover every path exactly once')
    names = [row['objectName'] for row in states[0]['rotations']]
    if len(names) != len(set(names)) or not names:
        raise ValueError('Invalid motion group selection')
    helpers = {name: bpy.context.scene.objects.get(name) for name in names}

    def ancestors(obj):
        result = []
        while obj.parent:
            obj = obj.parent
            result.append(obj)
        return result

    for helper in helpers.values():
        if not helper or helper.type != 'EMPTY' or helper == root or root not in ancestors(helper):
            raise ValueError('Pose target must be an assembly helper below the asset root')
        if any(parent in helpers.values() for parent in ancestors(helper)):
            raise ValueError('Nested moving groups are not calibrated')
        animation = helper.animation_data
        if animation and (animation.drivers or animation.nla_tracks):
            raise ValueError('Driven or NLA-composed pose helpers need a separate calibrated sampler')
        owned = [obj for obj in collision if helper in ancestors(obj)]
        if not owned:
            raise ValueError('A motion group has no actual collision geometry')
        for collider in owned:
            matches = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH'
                       and collider.name.startswith('UCX_' + obj.name + '_')]
            if len(matches) != 1 or helper not in ancestors(matches[0]):
                raise ValueError('Render and collision geometry must share the same motion group')

    saved = {name: (obj.rotation_mode, obj.rotation_euler.copy(), obj.matrix_basis.copy(),
                    obj.animation_data.action if obj.animation_data else None,
                    obj.animation_data.action_slot if obj.animation_data else None) for name, obj in helpers.items()}
    inverse = root.matrix_world.inverted()
    measured = []
    try:
        # Freeze action-driven helpers at explicitly approved measurement poses.
        # This is not evidence that the action or gameplay implements those poses.
        for obj in helpers.values():
            if obj.animation_data:
                obj.animation_data.action = None
        for state in states:
            if sorted(row['objectName'] for row in state['rotations']) != sorted(names):
                raise ValueError('Every pose must bind the same motion groups')
            wanted_matrices = {}
            for rotation in state['rotations']:
                obj = helpers[rotation['objectName']]
                pivot = inverse @ obj.matrix_world.translation
                if (pivot - Vector(rotation['pivotMeters'])).length > 1e-5:
                    raise ValueError('Actual motion pivot differs from the approved engineering pivot')
                angles = rotation['eulerDegrees']
                if len(angles) != 3 or any(not math.isfinite(v) or abs(v) > 360 for v in angles):
                    raise ValueError('Unsupported pose rotation')
                obj.rotation_mode = 'XYZ'
                obj.rotation_euler = tuple(math.radians(v) for v in angles)
                wanted_matrices[obj.name] = obj.parent.matrix_world @ obj.matrix_parent_inverse @ obj.matrix_basis
            bpy.context.view_layer.update()
            for name, wanted in wanted_matrices.items():
                evaluated = helpers[name].evaluated_get(bpy.context.evaluated_depsgraph_get()).matrix_world
                if any(abs(evaluated[i][j] - wanted[i][j]) > 1e-5 for i in range(4) for j in range(4)):
                    raise ValueError('Evaluated helper cannot reach the reviewed pose; constraints remain active')
            colliders = [(obj.name, [tuple(inverse @ point) for point in bounds_of([obj])]) for obj in collision]
            scoped = {**traversal, 'paths': [paths[state['pathId']]]}
            result = check_traversal(scoped, colliders)
            measured.append({'pathId': state['pathId'], 'rotations': state['rotations'], **result,
                             'colliders': [{'name': name, 'verticesMeters': points} for name, points in colliders]})
    finally:
        for name, (mode, euler, basis, action, slot) in saved.items():
            helpers[name].rotation_mode = mode
            helpers[name].rotation_euler = euler
            helpers[name].matrix_basis = basis
            if helpers[name].animation_data:
                helpers[name].animation_data.action = action
                if slot:
                    helpers[name].animation_data.action_slot = slot
        bpy.context.view_layer.update()
    return {'status': 'PASS' if all(row['status'] == 'PASS' for row in measured) else 'GAP',
            'paths': [path for row in measured for path in row['paths']], 'states': measured,
            'scope': 'Independent source geometry in reviewed poses; engine state bindings and dynamic gameplay remain separate gates.'}
