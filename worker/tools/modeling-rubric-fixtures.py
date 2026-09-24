"""Controlled fixed-image fixtures. Labels are preregistered outside the reviewer input."""
import argparse
import json
import math
import sys
from pathlib import Path
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).parent))
import bpy
from modeling_scene import load_scene, render_views, write_json, sha256

p = argparse.ArgumentParser(); p.add_argument('--out', required=True)
a = p.parse_args(sys.argv[sys.argv.index('--') + 1:]); root = Path(a.out).resolve(); root.mkdir(exist_ok=False, parents=True)
requirements = ['A brown stump has a visibly irregular top edge.', 'The top shows concentric growth rings.', 'Three flared roots join the trunk continuously.']
definitions = [
    ('positive-1', 'clear-positive', 0, 3, True, False, .07),
    ('positive-2', 'clear-positive', .3, 3, True, False, .09),
    ('positive-3', 'clear-positive', .6, 3, True, False, .06),
    ('positive-4', 'clear-positive', .9, 3, True, False, .08),
    ('negative-color', 'clear-negative', 0, 3, True, True, .07),
    ('negative-rings', 'clear-negative', 0, 3, False, False, .07),
    ('negative-roots', 'clear-negative', 0, 0, True, False, .07),
    ('negative-evidence', 'clear-negative', 0, 3, True, False, .07),
    ('borderline-fused', 'borderline', 0, 3, True, False, .07),
    ('borderline-rings', 'borderline', 0, 3, True, False, .07),
    ('borderline-top', 'borderline', 0, 3, True, False, .008),
    ('borderline-resolution', 'borderline', 0, 3, True, False, .07),
]
cases = []
def material(name, color):
    mat = bpy.data.materials.new(name); mat.use_nodes = True
    node = mat.node_tree.nodes['Principled BSDF']; node.inputs['Base Color'].default_value = (*color, 1); node.inputs['Roughness'].default_value = .8
    return mat
for name, group, phase, roots, rings, gray, uneven in definitions:
    directory = root/name; directory.mkdir(); bpy.ops.wm.read_factory_settings(use_empty=True)
    bark = material('Bark', (.25,.25,.25) if gray else (.24,.075,.024))
    wood = material('Cut wood', (.42,.42,.42) if gray else (.60,.30,.095))
    ink = material('Growth rings', (.12,.12,.12) if gray else ((.54,.27,.088) if name == 'borderline-rings' else (.19,.065,.02)))
    n=96; verts=[]; faces=[]; levels=[0,.08,.22,.45,.8,1.08]
    def height(angle): return 1.08 + uneven*(math.sin(3*angle+.4)+.45*math.sin(7*angle))
    for zi,z in enumerate(levels):
        for i in range(n):
            t=2*math.pi*i/n
            lobe = max(0, math.cos(roots*(t-phase)))**(2 if name == 'borderline-fused' else 8) if roots else 0
            flare = (.13 if name == 'borderline-fused' else .55)*lobe*max(0,1-z/.5)**2
            radius=.43+.035*math.sin(5*t+.3)+flare+.05*max(0,1-z/.5)
            verts.append((radius*math.cos(t),radius*math.sin(t),height(t) if zi==len(levels)-1 else z))
    for k in range(len(levels)-1):
        for i in range(n): faces.append((k*n+i,k*n+(i+1)%n,(k+1)*n+(i+1)%n,(k+1)*n+i))
    faces.append(tuple(reversed(range(n))))
    center=len(verts); verts.append((0,0,1.08))
    side_count=len(faces)
    for i in range(n): faces.append(((len(levels)-1)*n+i,(len(levels)-1)*n+(i+1)%n,center))
    mesh=bpy.data.meshes.new('Stump'); mesh.from_pydata(verts,[],faces); mesh.update()
    obj=bpy.data.objects.new('SM_Stump',mesh); bpy.context.collection.objects.link(obj); mesh.materials.append(bark); mesh.materials.append(wood)
    for poly in mesh.polygons: poly.material_index=int(poly.index>=side_count)
    if rings:
        for r in [.085,.16,.24,.32,.39]:
            curve=bpy.data.curves.new('Growth ring','CURVE');curve.dimensions='3D';curve.bevel_depth=.009;curve.bevel_resolution=1
            spline=curve.splines.new('POLY');spline.points.add(n-1);spline.use_cyclic_u=True
            for i,point in enumerate(spline.points):
                t=2*math.pi*i/n;radius=r*(1+.025*math.sin(5*t));outer=.43+.035*math.sin(5*t+.3)
                point.co=(radius*math.cos(t),radius*math.sin(t),1.08+(height(t)-1.08)*radius/outer+.009,1)
            ring=bpy.data.objects.new('Ring',curve);bpy.context.collection.objects.link(ring);curve.materials.append(ink)
            bpy.ops.object.select_all(action='DESELECT');ring.select_set(True);bpy.context.view_layer.objects.active=ring;bpy.ops.object.convert(target='MESH')
    bpy.ops.wm.save_as_mainfile(filepath=str(directory/'source.blend'))
    bpy.ops.export_scene.gltf(filepath=str(directory/'model.glb'),export_format='GLB')
    load_scene(directory/'model.glb')
    if name == 'negative-evidence':
        # Valid attached PNGs with no asset evidence; no accidental source/reference substitution.
        image=bpy.data.images.new('Empty evidence',width=384,height=384);image.generated_color=(0,0,0,1)
        image.filepath_raw=str(directory/'empty.png');image.file_format='PNG';image.save()
        views=[{'view':'empty','file':str(directory/'empty.png'),'sha256':sha256(directory/'empty.png')}]
    else:
        views=render_views(directory, ['front','side','back','top','perspective','lower-oblique'],size=96 if name=='borderline-resolution' else 384)
    labels = ['PASS']*3 if group=='clear-positive' else None
    if group=='clear-negative':
        labels={'negative-color':['GAP','PASS','PASS'],'negative-rings':['PASS','GAP','PASS'],'negative-roots':['PASS','PASS','GAP'],'negative-evidence':['GAP']*3}[name]
    cases.append({'id':name,'group':group,'requirements':requirements,'views':views,'expected':labels,'sourceHash':sha256(directory/'source.blend'),'exportHash':sha256(directory/'model.glb')})
    write_json(root/'fixtures.json',{'protocol':1,'labeler':'Codex maintainer: controlled geometry and independent image inspection, not the tested reviewer','cases':cases})
print(json.dumps({'cases':len(cases),'root':str(root)}))
