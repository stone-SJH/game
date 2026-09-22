# Modeling routing handoff

This reference describes the worker-owned modeling boundary. The harness owns the route and
state; the production agent consumes accepted model evidence and integrates it into the game.

## Before modeling

- Split the request into independently reviewable asset specifications.
- Record each requirement verbatim, including quality, precision, triangle, rig, mesh, material,
  and reference-image requirements.
- Inspect only licensed, registered assets in the current workspace. A filename match is not
  evidence of similarity or editability.
- Probe the actual Blender MCP stdio server and record its tool list and Blender version. A CLI
  installation alone is not an MCP capability.

## Route order

1. `reuse_blender`: a registered editable source plus bounded edits can satisfy every original
   requirement. Preserve source identity and record source hash.
2. `blender_direct`: use for precise, parametric, modular, or otherwise uncertain work. This is
   the conservative fallback when the evaluator or provider is unavailable.
3. `tripo_then_blender`: use only when the provider is enabled, the generated base is predicted
   to be closer than direct authoring, and Blender can complete small edits. Small edits cover
   transforms, local cleanup, materials, collision, and LOD; rebuilding the silhouette, global
   retopology, or a rig is outside this route.

Every route uses the same technical and visual checks. A provider success response, render, or
author statement is not an acceptance result.

## Handoff contract

The modeling host writes `plan/modeling-specs.json`, decisions under `plan/modeling/`, and
geometry reports, visual reviews, and hashes under `stages/asset-production-and-import/models/`.
Provider resumable state lives outside the project in the workspace's `modeling-state/` directory.
The main production agent must keep accepted source
and GLB files unchanged. A new asset or changed specification is requested through
`plan/modeling-request.json`; the host re-evaluates it on a bounded next iteration.

The Tripo adapter uses `https://openapi.tripo3d.com/v3` with the worker's China-region key;
it does not fail over to the international `.ai` endpoint. It reads the Git repository root's
`tripo.txt` (or `TRIPO_API_KEY_FILE`) only when it exists and is non-empty. The key
never enters prompts, arguments, logs, progress, reports, or artifacts. Each revision permits at
most one generation submission, with a default total of one new submission per run. An unknown submission result is never retried blindly. Credits,
authentication, rate limits, service errors, timeout, malformed output, download errors, and
quality gaps all return a recorded `blender_direct` fallback. Cancellation or unconfirmed process
shutdown propagates to the worker instead of starting a fallback.

## V2 staged modeling and engine handoff

`MODELING_HARNESS_V2_ENABLED=1` selects v2 intake for new tasks. Explicit specifications
containing a v2 `contract` also select it. Existing tasks keep their saved contract, skill
resource hashes and toolchain; a different release cannot restart their modeling budgets.
The default is `0` while the wider benchmark matrix is being calibrated.

The host copies the relevant `yahaha-blender-modeling`, `yahaha-blender-reference-fit`,
`yahaha-blender-lowpoly` and `yahaha-blender-unreal-handoff` resources into the task. It requests
a saved blockout, renders actual fixed views, checkpoints the source, then attaches those images
to final authoring. Each attempt shares one time budget across both stages. Preserve `recipe.py`,
`asset-manifest.json`, checkpoint manifests and QA images alongside the accepted source/exports.

V2 checks source and reimported GLB against measured dimensions, role-specific triangle budgets,
materials/UV/textures, pivot, required topology, collision proxies, LODs and binding. Required
actions must deform actual vertices; representative poses are supplied to image review.
Exact silhouette matching only applies to supplied binary masks and comparable orthographic views.

Accepted Blender output is `DCC_READY`. The production integration agent imports the declared
GLB/FBX, saves it and places it at unit scale in a dedicated map. Write
`plan/modeling-engine-imports.json` using the schema in the Unreal handoff skill. Host Unreal
checks plus independent review of real map captures establish `ENGINE_READY`. Neither state
replaces packaged-game/playtest acceptance.

The UE 5.8 FBX/Interchange converter maps `auto_generate_collision=false` to disabling collision
import, including UCX. Keep it true, import normals/tangents, verify the exact convex hull count,
and explicitly import required LOD files. The checker waits for shader compilation before capture.
Complex skeletal UE import, custom pivot mapping and lightmap packing remain uncalibrated and
produce a required GAP; never replace their requirements with a static-asset PASS.
