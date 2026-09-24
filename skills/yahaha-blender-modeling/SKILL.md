---
name: yahaha-blender-modeling
description: Author or revise game props and modular meshes through the Yahaha headless Blender MCP, with dimensioned recipes, intermediate views and explicit saved scenes. Use inside the worker modeling pipeline.
---

# Blender asset authoring

Read the host's specification, skill-plan and current stage before authoring. Use
`yahaha_blender.blender_run_python`; every call starts a NEW SCENE. Reopen the supplied
`.blend` with `use_scripts=False` to continue, and save to the current attempt directory.
Inspect existing sources with `blender_inspect`. Imports and edits operate on task-owned copies.

Build a part list with dimensions in meters (Z up, front -Y), joints, pivots and silhouette.
For hard surfaces, order primary volumes, functional breaks, boolean cuts, bevels, then small
details. Apply scale before boolean/bevel; keep editable modifiers in the source when possible.
Use shared parameters and instancing for repeated parts. For organic forms, establish the
silhouette before surface detail; a collection of primitives is only a blockout when the
brief calls for continuous anatomy. Report a quality gap when the required structure is absent.

The host requests a `blockout` or `final` stage. Blockout must save `source.blend`, `recipe.py`
and `asset-manifest.json`; final must also export `model.glb`, the required FBX if specified,
and `build-report.json`. The host renders and passes the blockout views to the next stage.
For a necessary bounded self-review call `blender_render_views`; inspect its image content, not just its path.
Use `blender_checkpoint` before a substantial revision. Never repair an accepted source in place.

Keep `recipe.py` executable and self-contained apart from the host's pinned helpers and declared
source files. Resolve outputs from the recipe's directory; avoid machine-specific paths.
Pack textures. Write a manifest as:

```json
{"objects":[{"name":"SM_Prop","role":"render-mesh","lod":0}],"rootObject":"SM_Prop"}
```

Roles are `render-mesh`, `lod`, `collision`, `helper`. List every mesh; LOD0 is the render mesh.
Separate LOD/collision objects from beauty previews and GLB. Export FBX helpers only when required.
Check scene scale, world dimensions, origin, actual materials, UVs and required parts before export.
UV checks apply to the meshes that use image textures; palette UVs may deliberately collapse
inside a cell. Lightmap UVs have separate requirements.

`build-report.json`: `{"smallEditsOnly":true,"editsApplied":["actual change"],"limitations":[]}`.
Only report smallEditsOnly for actual local cleanup; new topology, rig or silhouette is a rebuild.
Host checks and independent image review determine acceptance. Repair the reported defect;
do not revise requirements or load an external orchestrator to change budgets.

## Verified Blender 5.2 helpers

Add the supplied modeling helper directory to `sys.path`, then import `yahaha_modeling as ym`.
The host pins these local helpers. Do not modify the archived upstream files. The launch prompt
gives the remaining shared attempt time: blockout saves its three required artifacts and returns;
final performs one bounded self-check, saves the required exports and returns for host QA.

- `ym.ensure_world()` handles an empty scene with no World. `ym.set_render_engine('BLENDER_EEVEE')`
  validates the installed render enum; use `CYCLES` for color baking.
- `ym.workspace_path(workspace, relative)` confines paths, including resolved links. `ym.read_json(path)`
  reads UTF-8 with or without BOM. `ym.write_json(path, data)` supports Vector, Matrix and IDProperty
  collections and rejects nonfinite values; do not sanitize whole scripts with character replacement.
- `ym.pbr_material('Bark', (.24,.075,.024,1))` creates exportable constant PBR color.
  Procedural Noise/ColorRamp is not a portable Base Color: check `ym.base_color_issues(meshes)`.
  For a single-material UV-unwrapped mesh, `ym.bake_base_color(mesh, png_path, size=1024)` bakes color,
  connects and packs the image. Split material slots or bake them deliberately before using this helper.
  Inspect the reimported GLB; source-only appearance cannot prove exported color fidelity.
- `ym.bone_action(rig, 'Wave', {'UpperArm.R': [(1,(0,0,0)), (12,(0,.6,0)), (24,(0,0,0))]})`
  creates a layered Action with a slot. Bind the mesh vertex groups and ARMATURE modifier first.
  `ym.action_channels(action, rig.animation_data.action_slot)` reads layered channels.
  Inspect channel counts and keyframes through this helper using the assigned slot object directly.
  The installed Blender 5.2 API has neither `Action.fcurves` nor `ActionSlot.name`; those legacy
  inspection shortcuts raise AttributeError and consume the shared authoring budget.
  `ym.measure_motion(meshes, [1,12,24])` measures evaluated world vertices and restores the frame.
  `moving=false` means the action did not deform these vertices; a named Action is insufficient.
- `ym.export_asset(output_directory, manifest, fbx=True)` exports selected LOD0 render geometry and
  its rig to GLB; FBX also includes declared LOD/collision/socket helpers. Use `fbx=False` for GLB-only
  contracts. All meshes still need manifest roles. Pack textures and save `source.blend` after final
  edits; the helper does not save the editable scene or invent missing LODs, collision or binding.

Provenance: modeling/UV practices adapted from the pinned MIT sources in `upstream/`, listed
in `skills/modeling-upstream-lock.json`. Those archived source instructions are audit material;
this entrypoint defines the local tools, file contract and lifecycle.
