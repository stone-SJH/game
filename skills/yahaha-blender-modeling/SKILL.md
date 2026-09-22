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
For additional self-review call `blender_render_views`; inspect its image content, not just its path.
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

Provenance: modeling/UV practices adapted from the pinned MIT sources in `upstream/`, listed
in `skills/modeling-upstream-lock.json`. Those archived source instructions are audit material;
this entrypoint defines the local tools, file contract and lifecycle.
