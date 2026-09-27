"""UE 5.8 simple-collision sweeps with measured DCC-to-import coordinate alignment."""
import itertools
import math
import re
import unreal as u

NUMBER = r'[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?'
VECTOR = re.compile(r'\(X=('+NUMBER+r'),Y=('+NUMBER+r'),Z=('+NUMBER+r')\)')

def coords(v):
    return [float(v.x),float(v.y),float(v.z)]

def import_hulls(mesh):
    aggregate=mesh.get_editor_property('body_setup').get_editor_property('agg_geom')
    elements=aggregate.get_editor_property('convex_elems')
    if not 0 < len(elements) <= 64:
        raise ValueError('Unsupported collision hull count')
    hulls=[]
    for element in elements:
        # VertexData is not a Python UPROPERTY in 5.8. Struct export_text retains it.
        # Parse only the expected numeric serialization; never evaluate asset strings.
        text=element.export_text()
        match=re.search(r'VertexData=\((.*?)\),IndexData=',text)
        if not match:
            raise ValueError('Unavailable convex vertex serialization')
        vectors=VECTOR.findall(match.group(1))
        if not 4 <= len(vectors) <= 256:
            raise ValueError('Unsupported collision vertex count')
        if VECTOR.sub('',match.group(1)).replace(',','').strip():
            raise ValueError('Unexpected convex vertex serialization')
        points=[[float(v) for v in point] for point in vectors]
        if not all(math.isfinite(v) for point in points for v in point):
            raise ValueError('Non-finite collision coordinates')
        transform=re.search(r'Transform=\(Rotation=\(X=('+NUMBER+r'),Y=('+NUMBER+r'),Z=('+NUMBER+r'),W=('+NUMBER+r')\),Translation=(\(X=.*?\)),Scale3D=(\(X=.*?\))\)',text)
        if not transform:
            raise ValueError('Unmeasured convex local transform')
        quaternion=[float(v) for v in transform.groups()[:4]]
        shift=[float(v) for v in VECTOR.fullmatch(transform.group(5)).groups()]
        scale=[float(v) for v in VECTOR.fullmatch(transform.group(6)).groups()]
        if any(abs(v-w)>1e-6 for v,w in zip(quaternion,[0,0,0,1])) or any(abs(v)>1e-6 for v in shift) or any(abs(v-1)>1e-6 for v in scale):
            raise ValueError('Non-identity convex local transform is not calibrated')
        hulls.append(points)
    return hulls

def alignments(dcc, imported, tolerance_cm=.02):
    """Verify complete collider vertex sets, not sorted width/height bounds.

    Meter-to-centimeter, upright quarter-turn and handedness conversions are supported.
    A symmetric asset can have multiple valid mappings; every such path is tested.
    Other rotations or hull simplification return GAP until separately calibrated.
    """
    source=[row['verticesMeters'] for row in dcc.get('colliders',[])]
    if len(source)!=len(imported) or not source or sum(map(len,source))>4096 or any(len(h)>256 for h in source):
        raise ValueError('Missing or oversized DCC collision alignment evidence')
    def center(points):
        return [(min(p[i] for p in points)+max(p[i] for p in points))*.5 for i in range(3)]
    target_center=center([p for hull in imported for p in hull])
    def equivalent(left,right):
        # Match both directions. Duplicate seam vertices are harmless; missing hull detail is GAP.
        def contained(a,b):
            cells={}
            for q in b:
                key=tuple(math.floor(v/tolerance_cm) for v in q)
                cells.setdefault(key,[]).append(q)
            for p in a:
                key=tuple(math.floor(v/tolerance_cm) for v in p)
                near=(q for offset in itertools.product([-1,0,1],repeat=3)
                      for q in cells.get(tuple(v+d for v,d in zip(key,offset)),[]))
                if not any(sum((x-y)**2 for x,y in zip(p,q))<=tolerance_cm**2 for q in near): return False
            return True
        if any(abs(a-b)>tolerance_cm for a,b in zip(center(left),center(right))): return False
        return contained(left,right) and contained(right,left)
    results=[]
    for swap in [False,True]:
        for sx,sy in itertools.product([-1,1],repeat=2):
            def rotate(p):
                return [100*sx*p[1 if swap else 0],100*sy*p[0 if swap else 1],100*p[2]]
            rotated=[[rotate(p) for p in hull] for hull in source]
            origin=center([p for hull in rotated for p in hull])
            translation=[a-b for a,b in zip(target_center,origin)]
            remaining=list(range(len(imported)))
            for hull in rotated:
                shifted=[[a+b for a,b in zip(p,translation)] for p in hull]
                match=next((i for i in remaining if equivalent(shifted,imported[i])),None)
                if match is None: break
                remaining.remove(match)
            else:
                results.append({'swapXY':swap,'signX':sx,'signY':sy,'translationCm':translation,'toleranceCm':tolerance_cm})
    if not results:
        raise ValueError('DCC collision geometry cannot be aligned with actual imported hulls')
    return results

def trace(world,start,end,radius,half_height,ignored):
    # The named channel is verified by a control that blocks ONLY Visibility.
    channel=u.TraceTypeQuery.ECC_VISIBILITY
    hit=u.SystemLibrary.capsule_trace_single(world,start,end,radius,half_height,channel,False,ignored,u.DrawDebugTrace.NONE,False)
    if hit is None:
        return {'blocked':False,'initialOverlap':False}
    values=hit.to_tuple()
    if len(values)<4 or not isinstance(values[0],bool) or not isinstance(values[1],bool):
        raise ValueError('Unrecognized HitResult layout')
    return {'blocked':values[0],'initialOverlap':values[1],'distanceCm':float(values[3])}

def query_control(world,actor_system,actors):
    control=actor_system.spawn_actor_from_class(u.StaticMeshActor,u.Vector(100000,100000,100000))
    try:
        component=control.get_component_by_class(u.StaticMeshComponent)
        component.set_static_mesh(u.load_asset('/Engine/BasicShapes/Cube.Cube'))
        component.set_collision_profile_name('BlockAll')
        component.set_collision_response_to_all_channels(u.CollisionResponseType.ECR_IGNORE)
        component.set_collision_response_to_channel(u.CollisionChannel.ECC_VISIBILITY,u.CollisionResponseType.ECR_BLOCK)
        u.AutomationLibrary.finish_loading_before_screenshot()
        result=trace(world,u.Vector(99800,100000,100000),u.Vector(100200,100000,100000),10,20,actors)
        if not result['blocked']:
            raise ValueError('Positive collision query control was not blocked')
        return result
    finally:
        actor_system.destroy_actor(control)

def check_traversal(world,mesh,components,traversal,dcc):
    if not traversal:
        return {'status':'NOT_REQUESTED','paths':[]}
    rows=[]
    try:
        if not components or not dcc or dcc.get('status')!='PASS':
            raise ValueError('Missing successful DCC traversal evidence or map component')
        u.AutomationLibrary.finish_loading_before_screenshot()
        mappings=alignments(dcc,import_hulls(mesh))
        actor_system=u.get_editor_subsystem(u.EditorActorSubsystem)
        actors=list(actor_system.get_all_level_actors())
        control=query_control(world,actor_system,actors)
        radius=(traversal['capsule']['radiusMeters']+traversal['marginMeters'])*100
        height=(traversal['capsule']['halfHeightMeters']+traversal['marginMeters'])*100
        for actor,component in components:
            if component.get_collision_enabled() not in [u.CollisionEnabled.QUERY_ONLY,u.CollisionEnabled.QUERY_AND_PHYSICS]:
                raise ValueError('Target component collision queries are disabled')
            if component.get_collision_response_to_channel(u.CollisionChannel.ECC_VISIBILITY)!=u.CollisionResponseType.ECR_BLOCK:
                raise ValueError('Target component does not block the requested Visibility channel')
            rotation=component.get_world_rotation();scale=component.get_world_scale()
            if abs(rotation.pitch)>1e-4 or abs(rotation.roll)>1e-4 or any(abs(v-1)>1e-4 for v in coords(scale)):
                raise ValueError('Only upright unit-scale map instances are calibrated')
            transform=component.get_world_transform()
            for mapping in mappings:
                def world_point(p):
                    v=[p[1],p[0],p[2]] if mapping['swapXY'] else p
                    local=u.Vector(*[v[0]*100*mapping['signX']+mapping['translationCm'][0],
                                     v[1]*100*mapping['signY']+mapping['translationCm'][1],v[2]*100+mapping['translationCm'][2]])
                    return u.MathLibrary.transform_location(transform,local)
                for route in traversal['paths']:
                    start,end=world_point(route['startMeters']),world_point(route['endMeters'])
                    result=trace(world,start,end,radius,height,[])
                    rows.append({'pathId':route['id'],'component':component.get_path_name(),'mapping':mapping,
                                 'startCm':coords(start),'endCm':coords(end),**result})
        return {'status':'PASS' if rows and all(not r['blocked'] and not r['initialOverlap'] for r in rows) else 'GAP',
                'queryControl':control,'radiusCm':radius,'halfHeightCm':height,'paths':rows,'mappingMethod':'Full UCX vertex alignment; all symmetric mappings tested'}
    except Exception as exc:
        return {'status':'GAP','reason':str(exc)[:1500],'paths':rows}
