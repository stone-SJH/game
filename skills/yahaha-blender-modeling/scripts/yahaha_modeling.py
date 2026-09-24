"""Small author helpers verified with Blender 5.2; no host acceptance decisions."""
import json
import math
from collections.abc import Mapping
from pathlib import Path
import bpy


def workspace_path(workspace, relative):
    root = Path(workspace).resolve()
    value = Path(relative)
    if value.is_absolute() or '..' in value.parts:
        raise ValueError('Use a relative workspace path without parent traversal')
    result = (root / value).resolve()
    if not result.is_relative_to(root):
        raise ValueError('Workspace path escapes through a link')
    return result


def read_json(file):
    return json.loads(Path(file).read_text(encoding='utf-8-sig'))


def json_value(value, depth=0):
    if depth > 32:
        raise ValueError('JSON value is too deeply nested or cyclic')
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError('Non-finite JSON number')
        return value
    if isinstance(value, Mapping) or hasattr(value, 'items'):
        return {str(k): json_value(v, depth+1) for k, v in value.items()}
    if hasattr(value, 'to_list'):
        return json_value(value.to_list(), depth+1)
    if hasattr(value, '__iter__') or (hasattr(value, '__len__') and hasattr(value, '__getitem__')):
        return [json_value(v, depth+1) for v in value]
    raise TypeError('Unsupported JSON value: '+type(value).__name__)


def write_json(file, value):
    target = Path(file); target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(json_value(value), indent=2, allow_nan=False)+'\n', encoding='utf-8')


def ensure_world(color=(.12,.12,.12,1), strength=.7):
    scene = bpy.context.scene
    if scene.world is None:
        scene.world = bpy.data.worlds.new('World')
    scene.world.use_nodes = True
    nodes = scene.world.node_tree.nodes
    background = next((n for n in nodes if n.type == 'BACKGROUND'), None) or nodes.new('ShaderNodeBackground')
    output = next((n for n in nodes if n.type == 'OUTPUT_WORLD'), None) or nodes.new('ShaderNodeOutputWorld')
    scene.world.node_tree.links.new(background.outputs['Background'], output.inputs['Surface'])
    background.inputs['Color'].default_value = color
    background.inputs['Strength'].default_value = strength
    return scene.world


def set_render_engine(identifier):
    # Static RNA enum_items omits dynamically registered engines such as Cycles. The RNA setter
    # validates the installed runtime enum and rejects unknown identifiers without changing it.
    try:
        bpy.context.scene.render.engine = identifier
    except (TypeError, ValueError) as error:
        raise ValueError('Unavailable render engine: '+identifier) from error


def pbr_material(name, color=(.5,.5,.5,1), roughness=.65, metallic=0):
    mat = bpy.data.materials.new(name); mat.use_nodes = True
    nodes = mat.node_tree.nodes; nodes.clear()
    shader = nodes.new('ShaderNodeBsdfPrincipled'); output = nodes.new('ShaderNodeOutputMaterial')
    mat.node_tree.links.new(shader.outputs['BSDF'], output.inputs['Surface'])
    shader.inputs['Base Color'].default_value = color
    shader.inputs['Roughness'].default_value = roughness
    shader.inputs['Metallic'].default_value = metallic
    mat.diffuse_color = color
    return mat


def base_color_issues(objects):
    issues = []
    for obj in objects:
        for mat in obj.data.materials:
            if not mat or not mat.use_nodes:
                issues.append((obj.name, 'Missing node material')); continue
            output = next((n for n in mat.node_tree.nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output), None)
            links = output.inputs['Surface'].links if output else []
            shader = links[0].from_node if len(links) == 1 else None
            if not shader or shader.type != 'BSDF_PRINCIPLED':
                issues.append((obj.name, 'Surface must use one Principled shader')); continue
            color = shader.inputs['Base Color']
            if color.is_linked:
                node = color.links[0].from_node
                vector = node.inputs.get('Vector')
                uv_ok = not vector or not vector.is_linked or all(link.from_node.type=='UVMAP' or
                    (link.from_node.type=='TEX_COORD' and link.from_socket.name=='UV') for link in vector.links)
                if node.type != 'TEX_IMAGE' or not node.image or not obj.data.uv_layers.active or not uv_ok:
                    issues.append((obj.name, 'Bake procedural/mapped Base Color before export'))
    return issues


def bake_base_color(obj, file, size=1024):
    """Bake a single-material mesh to packed color pixels. Caller chooses workspace file and size."""
    if obj.type != 'MESH' or len(obj.data.materials) != 1 or not obj.data.materials[0]:
        raise ValueError('Color baking requires one mesh with exactly one material')
    if not isinstance(size, int) or size < 16 or size > 4096:
        raise ValueError('Texture size must be 16..4096')
    if not obj.data.uv_layers.active:
        raise ValueError('Unwrap UVs before baking')
    scene = bpy.context.scene; saved_engine = scene.render.engine; saved_device = scene.cycles.device
    selected = list(bpy.context.selected_objects); active = bpy.context.view_layer.objects.active
    old = obj.data.materials[0]; working = old.copy(); obj.data.materials[0] = working
    image = bpy.data.images.new(obj.name+'-BaseColor', width=size, height=size, alpha=False)
    image.colorspace_settings.name = 'sRGB'
    node = working.node_tree.nodes.new('ShaderNodeTexImage'); node.image = image; working.node_tree.nodes.active = node
    try:
        set_render_engine('CYCLES'); scene.cycles.device = 'CPU'
        bpy.ops.object.select_all(action='DESELECT'); obj.select_set(True); bpy.context.view_layer.objects.active = obj
        bpy.ops.object.bake(type='DIFFUSE', pass_filter={'COLOR'}, use_selected_to_active=False, margin=4)
        target = Path(file); target.parent.mkdir(parents=True, exist_ok=True)
        image.filepath_raw = str(target); image.file_format = 'PNG'; image.save(); image.pack()
        shader = next(n for n in working.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
        working.node_tree.links.new(node.outputs['Color'], shader.inputs['Base Color'])
        return image
    except Exception:
        obj.data.materials[0] = old
        raise
    finally:
        scene.render.engine = saved_engine
        scene.cycles.device = saved_device
        bpy.ops.object.select_all(action='DESELECT')
        for item in selected: item.select_set(True)
        bpy.context.view_layer.objects.active = active


def bone_action(rig, name, tracks):
    """tracks: {bone_name: [(frame, (Euler X,Y,Z radians)), ...]}; key insertion creates layered channels."""
    if rig.type != 'ARMATURE': raise ValueError('Expected an armature')
    if name in bpy.data.actions: raise ValueError('Action already exists; edit it explicitly instead of creating a silently renamed duplicate')
    action = bpy.data.actions.new(name); slot = action.slots.new(id_type='OBJECT', name=rig.name)
    rig.animation_data_create().action = action; rig.animation_data.action_slot = slot
    for bone_name, samples in tracks.items():
        bone = rig.pose.bones[bone_name]; bone.rotation_mode = 'XYZ'
        for frame, rotation in samples:
            bone.rotation_euler = rotation; bone.keyframe_insert(data_path='rotation_euler', frame=frame, group=bone_name)
    return action


def action_channels(action, slot):
    return [curve for layer in action.layers for strip in layer.strips
            for bag in [strip.channelbag(slot)] if bag for curve in bag.fcurves]


def measure_motion(objects, frames):
    """Measures evaluated world vertices, not mesh.data or unevaluated bone transforms."""
    previous = bpy.context.scene.frame_current; samples = []
    try:
        for frame in frames:
            bpy.context.scene.frame_set(frame); graph = bpy.context.evaluated_depsgraph_get(); points = []
            for obj in objects:
                evaluated = obj.evaluated_get(graph); mesh = evaluated.to_mesh()
                points.extend((evaluated.matrix_world @ v.co).copy() for v in mesh.vertices); evaluated.to_mesh_clear()
            samples.append(points)
        if not samples or not samples[0] or any(len(points)!=len(samples[0]) for points in samples):
            raise ValueError('Motion measurement requires stable nonempty evaluated topology')
        distance = max(((a-b).length for points in samples for a,b in zip(samples[0],points)), default=0)
        return {'frames':list(frames),'maxVertexDisplacementMeters':distance,'moving':distance>1e-5}
    finally:
        bpy.context.scene.frame_set(previous)


def export_asset(directory, manifest, fbx=False):
    """Select declared LOD0 plus required rig for GLB; FBX also includes declared collision/LOD/socket helpers."""
    directory = Path(directory); directory.mkdir(parents=True, exist_ok=True)
    rows = manifest['objects']; render = [bpy.data.objects[row['name']] for row in rows if row['role']=='render-mesh' and row.get('lod',0)==0]
    if not render: raise ValueError('Manifest has no LOD0 render mesh')
    issues = base_color_issues(render)
    if issues: raise ValueError('Nonportable Base Color: '+repr(issues))
    selected = list(bpy.context.selected_objects); active = bpy.context.view_layer.objects.active
    hidden = {obj: obj.hide_get() for obj in bpy.context.scene.objects}
    rigs = {mod.object for obj in render for mod in obj.modifiers if mod.type=='ARMATURE' and mod.object}
    root = bpy.data.objects[manifest['rootObject']]
    def select(objects):
        bpy.ops.object.select_all(action='DESELECT')
        for obj in objects: obj.hide_set(False); obj.select_set(True)
        bpy.context.view_layer.objects.active = render[0]
    try:
        bpy.ops.file.pack_all()
        # Include a non-mesh root for pivot/hierarchy, never a helper mesh in the GLB.
        select(set(render)|rigs|({root} if root.type!='MESH' else set()))
        bpy.ops.export_scene.gltf(filepath=str(directory/'model.glb'),export_format='GLB',use_selection=True)
        if fbx:
            select({bpy.data.objects[row['name']] for row in rows}|rigs|{root})
            bpy.ops.export_scene.fbx(filepath=str(directory/'model.fbx'),use_selection=True,add_leaf_bones=False,
                apply_unit_scale=True,axis_forward='-Z',axis_up='Y',bake_anim=True)
    finally:
        bpy.ops.object.select_all(action='DESELECT')
        for obj in selected: obj.select_set(True)
        bpy.context.view_layer.objects.active = active
        for obj, value in hidden.items(): obj.hide_set(value)
