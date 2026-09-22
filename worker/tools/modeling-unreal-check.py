"""Host-owned Unreal import and map evidence. Run via -run=pythonscript -script=wrapper.py."""
import hashlib
import json
import math
from pathlib import Path
import unreal as u


def file_hash(file):
    digest = hashlib.sha256()
    with open(file, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024*1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def components_for(mesh):
    actor_system = u.get_editor_subsystem(u.EditorActorSubsystem)
    result = []
    for actor in actor_system.get_all_level_actors():
        for component in actor.get_components_by_class(u.StaticMeshComponent):
            if component.static_mesh == mesh:
                result.append((actor, component))
    return result


def capture(world, actors, directory):
    u.AutomationLibrary.finish_loading_before_screenshot()
    actor_system = u.get_editor_subsystem(u.EditorActorSubsystem)
    lod_settings = []
    for actor in actors:
        for mesh_component in actor.get_components_by_class(u.StaticMeshComponent):
            lod_settings.append((mesh_component,mesh_component.get_editor_property('forced_lod_model')))
            mesh_component.set_forced_lod_model(1)  # LOD0, matching the measured geometry and source views.
    center, extent = actors[0].get_actor_bounds(False)
    scale = max(extent.x,extent.y,extent.z,1)*2
    capture_actor = actor_system.spawn_actor_from_class(u.SceneCapture2D,u.Vector(0,0,0))
    component = capture_actor.get_component_by_class(u.SceneCaptureComponent2D)
    component.set_editor_property('projection_type',u.CameraProjectionMode.ORTHOGRAPHIC)
    component.set_editor_property('ortho_width',scale*1.8)
    component.set_editor_property('capture_source',u.SceneCaptureSource.SCS_FINAL_COLOR_LDR)
    component.set_editor_property('capture_every_frame',False)
    post = component.get_editor_property('post_process_settings')
    post.set_editor_property('override_auto_exposure_method',True)
    post.set_editor_property('auto_exposure_method',u.AutoExposureMethod.AEM_MANUAL)
    post.set_editor_property('override_auto_exposure_apply_physical_camera_exposure',True)
    post.set_editor_property('auto_exposure_apply_physical_camera_exposure',False)
    component.set_editor_property('post_process_settings',post)
    component.set_editor_property('primitive_render_mode',u.SceneCapturePrimitiveRenderMode.PRM_USE_SHOW_ONLY_LIST)
    for actor in actors:
        component.show_only_actor_components(actor)
    target = u.RenderingLibrary.create_render_target2d(world,512,512,u.TextureRenderTargetFormat.RTF_RGBA8)
    component.set_editor_property('texture_target',target)
    lights=[]
    for position,intensity in [((2,-3,4),3),((-3,-1,2),1.5),((1,3,3),1)]:
        location=center+u.Vector(*position)*scale
        light=actor_system.spawn_actor_from_class(u.DirectionalLight,location)
        light.set_actor_rotation(u.MathLibrary.find_look_at_rotation(location,center),False)
        light_component=light.get_component_by_class(u.DirectionalLightComponent)
        light_component.set_mobility(u.ComponentMobility.MOVABLE)
        light_component.set_cast_shadows(False)
        light_component.set_intensity(intensity)
        lights.append(light)
    views=[]
    for name,offset in [('front',(0,-4,1)),('side',(4,0,1)),('perspective',(3,-3,2))]:
        location=center+u.Vector(*offset)*scale
        capture_actor.set_actor_location(location,False,False)
        capture_actor.set_actor_rotation(u.MathLibrary.find_look_at_rotation(location,center),False)
        component.capture_scene()
        u.RenderingLibrary.export_render_target(world,target,str(directory),name+'.png')
        file=directory/(name+'.png')
        if not file.is_file() or file.stat().st_size < 100:
            raise RuntimeError('UE did not produce a screenshot')
        views.append({'view':name,'file':str(file),'sha256':file_hash(file)})
    actor_system.destroy_actor(capture_actor)
    for light in lights:
        actor_system.destroy_actor(light)
    for mesh_component,forced_lod in lod_settings:
        mesh_component.set_forced_lod_model(forced_lod)
    return views


def validate(request_file, report_file):
    request=json.loads(Path(request_file).read_text(encoding='utf-8-sig'))
    rows=[]
    level_system=u.get_editor_subsystem(u.LevelEditorSubsystem)
    mesh_system=u.get_editor_subsystem(u.StaticMeshEditorSubsystem) or u.get_default_object(u.StaticMeshEditorSubsystem)
    for item in request['assets']:
        spec, entry = item['spec'], item['import']
        c=spec['contract']; gates=[]; views=[]
        def gate(name, passed, expected, actual):
            gates.append({'id':name,'status':'PASS' if passed else 'GAP','expected':expected,'actual':actual})
        try:
            mesh=u.load_asset(entry['packagePath'])
            gate('assetExists',mesh is not None,entry['packagePath'],mesh.get_path_name() if mesh else None)
            if not isinstance(mesh,u.StaticMesh):
                # Skeletal animation/deformation must have a calibrated validator, never a placeholder PASS.
                gate('validatedAssetClass',False,'Calibrated static-mesh importer',str(type(mesh)))
            else:
                data=mesh.get_editor_property('asset_import_data')
                imported_files=list(data.extract_filenames()) if data else []
                imported_hashes=[file_hash(f) for f in imported_files if Path(f).is_file()]
                gate('sourceIdentity',item['sourceHash'] in imported_hashes,item['sourceHash'],imported_hashes)
                bounds=mesh.get_bounds()
                extent=bounds.box_extent
                # Profiles preserve physical size; axis orientation is checked separately in real views.
                dims=[extent.x*2/100,extent.y*2/100,extent.z*2/100]
                target=c['dimensions']['meters'] or item['dccDimensions']
                tol=c['dimensions']['toleranceMeters']
                gate('dimensions',abs(dims[2]-target[2])<=tol and all(abs(a-b)<=tol for a,b in zip(sorted(dims[:2]),sorted(target[:2]))),target,dims)
                mode = c['pivot']['mode']
                if mode in ['center', 'base-center']:
                    origin = bounds.origin
                    actual = [origin.x/100, origin.y/100, origin.z/100]
                    wanted = [0, 0, extent.z/100 if mode == 'base-center' else 0]
                    gate('pivot',all(abs(a-b)<=c['pivot']['toleranceMeters'] for a,b in zip(actual,wanted)),wanted,actual)
                elif mode == 'custom':
                    gate('pivot',False,'Calibrated custom pivot mapping','not calibrated')
                triangles=mesh.get_num_triangles(0)
                gate('triangleBudget',0<triangles<=spec['maxTriangles'],spec['maxTriangles'],triangles)
                slots=mesh.get_editor_property('static_materials')
                gate('materials',0<len(slots)<=c['budgets']['materials'] and all(s.material_interface for s in slots),
                     c['budgets']['materials'],[s.material_interface.get_path_name() if s.material_interface else None for s in slots])
                if c['runtime']['collision']=='convex':
                    collisions=mesh_system.get_convex_collision_count(mesh)
                    expected=item.get('dccCollisionCount',1)
                    gate('collision',collisions==expected and collisions>0,{'convexHullCount':expected},collisions)
                lod_count=mesh_system.get_lod_count(mesh)
                gate('lodCount',lod_count>=1+len(c['runtime']['lodTriangles']),1+len(c['runtime']['lodTriangles']),lod_count)
                for i,budget in enumerate(c['runtime']['lodTriangles'],1):
                    count=mesh.get_num_triangles(i) if i<lod_count else 0
                    gate('lod'+str(i),0<count<=budget,budget,count)
                for name in c['runtime']['sockets']:
                    gate('socket:'+name,mesh.find_socket(name) is not None,name,None)
                if c['runtime']['lightmapUV']:
                    gate('lightmapUV',False,'Validated padding/non-overlap','not calibrated')
                if not level_system.load_level(entry['mapPath']):
                    raise RuntimeError('Cannot load asset test map')
                components=components_for(mesh)
                gate('placedInMap',bool(components),entry['mapPath'],len(components))
                gate('instanceScale',bool(components) and all(all(abs(v-1)<1e-4 for v in [cmp.get_world_scale().x,cmp.get_world_scale().y,cmp.get_world_scale().z]) for _,cmp in components),
                     'Unit scale for inspection',len(components))
                if components:
                    directory=Path(report_file).parent/spec['assetId']
                    directory.mkdir(parents=True,exist_ok=True)
                    world=u.get_editor_subsystem(u.UnrealEditorSubsystem).get_editor_world()
                    views=capture(world,[a for a,_ in components],directory)
                package_file=(Path(u.Paths.project_content_dir())/(entry['packagePath'].split('.')[0][len('/Game/'):]+'.uasset')).resolve()
                gate('savedPackage',package_file.is_file(),str(package_file),file_hash(package_file) if package_file.is_file() else None)
        except Exception as exc:
            gate('engineInspection',False,'Measured engine evidence',str(exc)[:1000])
        rows.append({'assetId':spec['assetId'],'requirementsHash':item['requirementsHash'],'gates':gates,'views':views,
                     'passed':bool(gates) and all(g['status']=='PASS' for g in gates) and bool(views)})
    result={'protocol':2,'requestHash':file_hash(request_file),'engineVersion':u.SystemLibrary.get_engine_version(),
            'assets':rows,'passed':all(r['passed'] for r in rows)}
    Path(report_file).write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
    return result
