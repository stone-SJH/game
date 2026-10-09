"""Blender regression: matching assembly poses, real obstacles and state restoration."""
import copy
import math
import sys
from pathlib import Path
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import bpy
from modeling_traversal_states import measure_states
from modeling_traversal import check_traversal
from modeling_scene import bounds_of

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
root = bpy.data.objects.new('ROOT', None)
bpy.context.scene.collection.objects.link(root)
joint = bpy.data.objects.new('hinge', None)
bpy.context.scene.collection.objects.link(joint)
joint.parent = root
joint.location.z = 1

def cube(name, location, scale, parent):
    bpy.ops.mesh.primitive_cube_add(size=1)
    obj = bpy.context.object
    obj.name = name
    obj.parent = parent
    obj.location = location
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return obj

mesh = cube('deck', (0, 0, 0), (4, 6, .2), joint)
collider = cube('UCX_deck_00', (0, 0, 0), (4, 6, .2), joint)
paths = []
states = []
for degrees in [0, 20, -20]:
    angle = math.radians(degrees)
    path_id = 'pose-' + str(degrees)
    height = lambda y: 1 + .1 / math.cos(angle) + math.tan(angle) * y + .8
    paths.append({'id': path_id, 'startMeters': [0, -2, height(-2)], 'endMeters': [0, 2, height(2)]})
    states.append({'pathId': path_id, 'rotations': [{'objectName': 'hinge', 'pivotMeters': [0, 0, 1], 'eulerDegrees': [degrees, 0, 0]}]})
traversal = {'version': 1, 'space': 'asset-local-meters', 'capsule': {'axis': 'Z', 'radiusMeters': .25, 'halfHeightMeters': .6},
             'marginMeters': .05, 'paths': paths, 'ueQuery': {'channel': 'Visibility', 'traceComplex': False}}
record = {'approval': {'approved': True}, 'plan': {'states': states}}
bpy.context.view_layer.update()
before = joint.matrix_basis.copy()
static = check_traversal(traversal, [(collider.name, [tuple(p) for p in bounds_of([collider])])])
assert static['status'] == 'GAP', static
result = measure_states(traversal, [collider], root, record)
assert result['status'] == 'PASS', result
assert joint.matrix_basis == before
joint.keyframe_insert(data_path='rotation_euler', frame=1)
action = joint.animation_data.action
assert measure_states(traversal, [collider], root, record)['status'] == 'PASS'
assert joint.animation_data.action == action
assert joint.matrix_basis == before
blocker = cube('obstacle', (0, 0, 1.9), (.1, .1, 1), root)
bpy.context.view_layer.update()
assert measure_states(traversal, [collider, blocker], root, record)['status'] == 'GAP'
assert joint.matrix_basis == before
bpy.data.objects.remove(blocker, do_unlink=True)

limit = joint.constraints.new('LIMIT_ROTATION')
limit.owner_space = 'LOCAL'
limit.use_limit_x = True
limit.min_x, limit.max_x = math.radians(-20), math.radians(20)
assert measure_states(traversal, [collider], root, record)['status'] == 'PASS'
limit.min_x, limit.max_x = -.01, .01
try:
    measure_states(traversal, [collider], root, record)
    raise AssertionError('A constraint must not silently alter the approved pose')
except ValueError:
    pass
joint.constraints.remove(limit)

for case in ['unapproved', 'missing-path', 'wrong-pivot', 'independent-collider']:
    bad = copy.deepcopy(record)
    if case == 'unapproved': bad['approval']['approved'] = False
    if case == 'missing-path': bad['plan']['states'].pop()
    if case == 'wrong-pivot': bad['plan']['states'][1]['rotations'][0]['pivotMeters'][0] = .1
    if case == 'independent-collider': mesh.parent = root
    try:
        measure_states(traversal, [collider], root, bad)
        raise AssertionError('Expected rejection: ' + case)
    except ValueError:
        pass
    assert joint.matrix_basis == before
    mesh.parent = joint
print('TRAVERSAL_STATES_PASS: static counterexample, three states, real obstruction, four invalid plans, transform restoration')
