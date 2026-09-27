"""Run via a UE Python wrapper calling run(request_file, report_file). No asset saves."""
import hashlib
import json
import sys
from pathlib import Path
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
import unreal as u
from modeling_unreal_traversal import check_traversal

def run(request_file,report_file):
    request=json.loads(Path(request_file).read_text(encoding='utf-8-sig'))
    level=u.get_editor_subsystem(u.LevelEditorSubsystem)
    assert level.load_level(request['mapPath'])
    system=u.get_editor_subsystem(u.EditorActorSubsystem)
    world=u.get_editor_subsystem(u.UnrealEditorSubsystem).get_editor_world()
    mesh=u.load_asset(request['packagePath'])
    pairs=[(actor,component) for actor in system.get_all_level_actors() for component in actor.get_components_by_class(u.StaticMeshComponent) if component.static_mesh==mesh]
    assert pairs
    original=[(actor,actor.get_actor_transform()) for actor,_ in pairs]
    files=list(Path(u.Paths.project_content_dir()).rglob('*.uasset'))+list(Path(u.Paths.project_content_dir()).rglob('*.umap'))
    digest=lambda:{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    before=digest();rows=[];blocker=None
    def check(label,wanted):
        result=check_traversal(world,mesh,pairs,request['traversal'],request['dccTraversal'])
        rows.append({'case':label,'expected':wanted,'passed':result['status']==wanted,'result':result})
        return result
    try:
        clear=check('original-door','PASS')
        if clear['status']=='PASS':
            path=clear['paths'][0]
            center=[(a+b)*.5 for a,b in zip(path['startCm'],path['endCm'])]
            blocker=system.spawn_actor_from_class(u.StaticMeshActor,u.Vector(*center))
            component=blocker.get_component_by_class(u.StaticMeshComponent)
            component.set_static_mesh(u.load_asset('/Engine/BasicShapes/Cube.Cube'))
            blocker.set_actor_scale3d(u.Vector(1,.01,2))
            component.set_collision_profile_name('BlockAll')
            check('thin-blocker','GAP')
            system.destroy_actor(blocker);blocker=None
            for actor,_ in pairs:
                actor.set_actor_location(u.Vector(350,-270,100),False,False)
                actor.set_actor_rotation(u.Rotator(yaw=90),False)
            check('translated-90-degree-instance','PASS')
            for actor,_ in pairs: actor.set_actor_scale3d(u.Vector(-1,1,1))
            check('mirrored-instance','GAP')
            for actor,transform in original: actor.set_actor_transform(transform,False,False)
            for _,component in pairs: component.set_collision_enabled(u.CollisionEnabled.NO_COLLISION)
            check('queries-disabled','GAP')
            for _,component in pairs: component.set_collision_enabled(u.CollisionEnabled.QUERY_AND_PHYSICS)
            check('restored-door','PASS')
    finally:
        if blocker: system.destroy_actor(blocker)
        for actor,transform in original: actor.set_actor_transform(transform,False,False)
    after=digest()
    report={'passed':len(rows)==6 and all(r['passed'] for r in rows) and before==after,
            'engineVersion':u.SystemLibrary.get_engine_version(),'cases':rows,'fileHashesBefore':before,'fileHashesAfter':after,'filesUnchanged':before==after}
    Path(report_file).write_text(json.dumps(report,indent=2),encoding='utf-8')
    print('UNREAL_TRAVERSAL_RESULTS',report['passed'],len(rows))
    return report
