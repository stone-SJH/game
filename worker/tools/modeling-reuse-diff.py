"""Read-only geometry/material comparison for a bounded reuse edit, independent of author claims."""
import argparse
import hashlib
import json
import sys
from pathlib import Path
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).parent))
import bpy
from modeling_scene import load_scene, mesh_objects, sha256, write_json


def fingerprint(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()


def inspect(file, manifest_file=None):
    file = Path(file); before = sha256(file); load_scene(file)
    manifest = json.loads(Path(manifest_file).read_text(encoding='utf-8-sig')) if manifest_file else None
    graph=bpy.context.evaluated_depsgraph_get(); triangles=[]; materials=[]; mesh_count=0
    for obj in mesh_objects(manifest):
        mesh_count+=1; evaluated=obj.evaluated_get(graph); mesh=evaluated.to_mesh();mesh.calc_loop_triangles()
        try:
            if len(triangles)+len(mesh.loop_triangles)>500000:raise ValueError('Reuse diagnostic triangle budget exceeded')
            points=[tuple(round(v,6) for v in evaluated.matrix_world@vertex.co) for vertex in mesh.vertices]
            # Triangle soup is independent of mesh names, vertex indexing, face order and object grouping.
            triangles.extend(tuple(sorted(points[index] for index in triangle.vertices)) for triangle in mesh.loop_triangles)
            for mat in mesh.materials:
                if mat is None:materials.append({'object':obj.name,'material':None});continue
                nodes=mat.node_tree.nodes if mat.use_nodes else []
                shader=next((n for n in nodes if n.type=='BSDF_PRINCIPLED'),None)
                color=shader.inputs['Base Color'] if shader else None
                textures=[]
                for node in nodes:
                    if node.type=='TEX_IMAGE' and node.image:
                        im=node.image
                        # Hash decoded pixel evidence, not a machine-specific texture filename.
                        import array
                        pixels=array.array('f',im.pixels[:]);textures.append({'size':list(im.size),'pixelsHash':hashlib.sha256(pixels.tobytes()).hexdigest()})
                materials.append({'object':obj.name,'material':mat.name,'baseColor':list(color.default_value) if color else list(mat.diffuse_color),
                                  'baseColorLinked':bool(color and color.is_linked),'textures':textures})
        finally:evaluated.to_mesh_clear()
    after=sha256(file)
    if after!=before:raise ValueError('Inspection changed the source file')
    return {'file':str(file),'sha256':before,'geometryHash':fingerprint(sorted(triangles)),
            'triangles':len(triangles),'meshCount':mesh_count,'materials':materials,'coordinateQuantumMeters':1e-6}


def compare(source, target, source_manifest=None, target_manifest=None):
    a=inspect(source,source_manifest);b=inspect(target,target_manifest)
    def colors(row):
        return sorted([{'baseColor':m.get('baseColor'),'linked':m.get('baseColorLinked'),'textures':m.get('textures')} for m in row['materials']],key=fingerprint)
    return {'protocol':1,'source':a,'target':b,'geometryUnchanged':a['geometryHash']==b['geometryHash'],
            'materialsChanged':fingerprint(colors(a))!=fingerprint(colors(b)),
            'note':'Geometry compares world-space triangle positions rounded to one micrometer. Different triangulation counts as a geometry change; inspect the recorded difference, not a route label. Material comparison ignores names but retains multiplicity and decoded textures. This report is evidence, not automatic visual acceptance.'}


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--source',required=True);p.add_argument('--target',required=True)
    p.add_argument('--source-manifest');p.add_argument('--target-manifest');p.add_argument('--report',required=True)
    a=p.parse_args(sys.argv[sys.argv.index('--')+1:]);write_json(a.report,compare(a.source,a.target,a.source_manifest,a.target_manifest))
