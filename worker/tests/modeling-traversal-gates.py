"""Read-only retained doorway checks plus in-memory blocked-door counterexamples."""
import argparse
import copy
import json
import sys
from pathlib import Path
sys.dont_write_bytecode = True
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
import bpy
from modeling_scene import load_scene, sha256, write_json
from modeling_quality import check_scene
parser=argparse.ArgumentParser();parser.add_argument('--out',required=True);parser.add_argument('--retained-root',required=True)
args=parser.parse_args(sys.argv[sys.argv.index('--')+1:])
root=Path(args.retained_root);rows=[]
traversal={'version':1,'space':'asset-local-meters','capsule':{'radiusMeters':.42,'halfHeightMeters':.96,'axis':'Z'},
           'marginMeters':.005,'paths':[{'id':'center','startMeters':[0,-1,.97],'endMeters':[0,1,.97]}],
           'ueQuery':{'channel':'Visibility','traceComplex':False}}
for i in range(1,4):
    project=root/'04-modular'/f'modular-{i}'/'project'
    summary=json.loads((project/'plan/modeling-results.json').read_text(encoding='utf-8-sig'))
    asset=summary['assets'][0];spec=copy.deepcopy(asset['spec'])
    source=project/next(f['path'] for f in asset['files'] if f['path'].endswith('/source.blend'))
    manifest=json.loads((source.parent/'asset-manifest.json').read_text(encoding='utf-8-sig'))
    before=sha256(source);load_scene(source)
    legacy=check_scene(spec,manifest)
    assert next(g for g in legacy['gates'] if g['id']=='traversal')['status']=='NOT_REQUESTED'
    spec['contract']['traversal']=traversal
    def check(label,want):
        bpy.context.view_layer.update()
        report=check_scene(spec,manifest)
        gate=next(g for g in report['gates'] if g['id']=='traversal')
        assert gate['status']==want,(i,label,gate)
        rows.append({'sample':f'modular-{i}','case':label,'passed':True,'gate':gate})
    check('unblocked-door','PASS')
    collision=next(bpy.data.objects[e['name']] for e in manifest['objects'] if e['role']=='collision')
    matrix=collision.matrix_world.copy()
    # Inject a closed convex blocker, with a valid UCX name and role, in the opening.
    bpy.ops.mesh.primitive_cube_add(size=1,location=(0,0,1))
    blocker=bpy.context.object;blocker.name=collision.name+'_Blocker';blocker.scale=(1,.001,2)
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    manifest['objects'].append({'name':blocker.name,'role':'collision','lod':0})
    check('thin-blocker','GAP')
    manifest['objects'].pop();bpy.data.objects.remove(blocker,do_unlink=True)
    check('blocker-removed','PASS')
    asset_root=bpy.data.objects[manifest['rootObject']]
    asset_root.scale.x=2
    check('unsupported-scaled-root','GAP')
    assert sha256(source)==before
write_json(Path(args.out)/'traversal-gates-report.json',{'passed':True,'cases':rows,'originalSourcesUnchanged':True})
print('TRAVERSAL_GATE_RESULTS '+json.dumps({'passed':True,'cases':len(rows)}))
