# Modeling routing handoff

This reference describes the worker-owned modeling boundary. The harness owns the route and
state; the production agent consumes accepted or explicitly provisional model evidence and integrates it into the game.

## Before modeling

- Split the request into independently reviewable asset specifications.
- Record each requirement verbatim, including quality, precision, triangle, rig, mesh, material,
  and reference-image requirements.
- Generated V2 assets first form a draft. Missing traversal data is resolved by a bounded
  engineering planner before authoring: one player capsule, clearance, local center paths,
  dimensions and pivot. Unspecified measurements are documented project decisions, never
  asserted as measurements of a referenced game. Supplied constraints remain immutable.
- Treat malformed agent JSON and inconsistent generated contracts as internal handoff repairs.
  The host retains the preceding response and field-level findings for the responsible agent;
  repair those findings without regenerating assets or asking the user for internal schema fields.
  `maxTriangles` is LOD0; `runtime.lodTriangles` contains only strictly decreasing LOD1+ budgets.
  The draft adapter records removal of an exactly repeated LOD0 when the remaining budgets are
  already valid. Explicit/frozen contracts are never normalized. Missing traversal is deferred
  to engineering, but it must not hide LOD, profile or other contract defects.
- Internal repairs use the same durable stage budget, deadline and evidence. A valid visual GAP
  requires an author repair; it is never resampled into PASS. Integrity/process-stop failures
  stop immediately. If review infrastructure remains unavailable after bounded repair but the
  technical export checks passed, retain an unreviewed provisional artifact with score zero;
  continue the round and retry review later. Never claim the unmeasured visual criteria passed.
- Engineering normalization may complete only host-determined handoff choices: a non-rigged asset
  with a complete traversal path uses `fbx-static` plus convex collision, and a rigged player
  uses controller/gameplay traversal acceptance instead of a mesh sweep. It never invents a
  dimension, capsule, pivot coordinate or path. These repairs are written to validation evidence.
- Exhausted intake or engineering reviews produce `PLANNING_PROVISIONAL`. The host retains the
  complete objective, draft assets, raw responses and exact field findings under
  `plan/modeling-planning/iteration-N/`. These are unresolved inputs, not approved contracts.
  Finish the playable round with documented temporary engine-native representations and actual
  measurements; record the planning gap without asking the user to repair agent JSON. Do not
  create a modeling revision to reopen calls in the same round. The next whole production
  iteration repairs the evidence internally; successful intake is reused. Never claim such a
  provisional representation meets the original modeling contract.
- The planner receives verified uploaded images/text and records every objective requirement,
  its implementation and verification, plus unresolved reference facts. Read-only research can
  inspect sources; unknown facts remain acceptance obligations. Code-only requests retain this
  requirement coverage without inventing model work.
- Inspect only licensed, registered assets in the current workspace. A filename match is not
  evidence of similarity or editability.
- Probe the actual Blender MCP stdio server and record its tool list and Blender version. A CLI
  installation alone is not an MCP capability.

## Route order

1. `reuse_blender`: a registered editable source plus bounded edits can satisfy every original
   requirement. Preserve source identity and record source hash.
2. `image_tripo_blender`: prefer for detailed skeletal characters and high-complexity organic
   subjects. Generate a concept with the configured local GPT Image 2 router, independently
   inspect its actual pixels against the original appearance requirements, and submit only an
   approved image to Tripo image-to-model. Blender preserves the generated detail while repairing
   topology, materials, rig, weights, requested animations and exports. This route permits those
   substantial refinements; it is not constrained by the legacy small-edit heuristic.
   Keep original references separate from the concept. A concept approval does not prove model
   fidelity, topology, rig motion or engine acceptance. A rejected concept gets one new draft,
   never a second vote on identical pixels. Retain image/review hashes and provider task evidence.
   Service/review gaps retain the best existing artifact and finish the whole iteration. They
   must not trigger a long primitive-based rebuild. Subsequent rounds refine the best retained
   Blender source without paying to regenerate its image or 3D base.
3. `blender_direct`: use for precise, parametric, modular, or simple low-poly work. This is
   the conservative fallback for these subjects when the evaluator or provider is unavailable.
4. `tripo_then_blender`: use only when the provider is enabled, the generated base is predicted
   to be closer than direct authoring, and Blender can complete small edits. Small edits cover
   transforms, local cleanup, materials, collision, and LOD; rebuilding the silhouette, global
   retopology, or a rig is outside this route.

Every route uses the same technical and visual checks. A provider success response, render, or
author statement is not an acceptance result.

## Handoff contract

The modeling host writes `plan/modeling-specs.json`, decisions under `plan/modeling/`, and
geometry reports, visual reviews, and hashes under `stages/asset-production-and-import/models/`.
Generated V2 intake also writes `plan/engineering-plan.json`. The host protects its hash and
requires final criteria for every original requirement ID. Report `playerMetrics` in meters
with the exact frozen capsule and real runtime evidence. Resolve `unresolvedFacts` through
`referenceResolutions` with actual research evidence; neither the plan nor the acceptance report
itself proves execution. Dynamic gates, gliding, climbing and puzzle completion need gameplay tests.
Provider resumable state lives outside the project in the workspace's `modeling-state/` directory.
The main production agent must keep accepted source
and GLB files unchanged. A new asset or changed specification is requested through
`plan/modeling-request.json`; the host re-evaluates it on a bounded next iteration.
Continue integration and packaging after recording that request. Its repair/application happens
after this whole round has been assessed and retained; do not exit early to obtain fresh budgets.

The Tripo adapter uses `https://openapi.tripo3d.com/v3` with the worker's China-region key;
it does not fail over to the international `.ai` endpoint. It reads the Git repository root's
`tripo.txt` (or `TRIPO_API_KEY_FILE`) only when it exists and is non-empty. The key
never enters prompts, arguments, logs, progress, reports, or artifacts. The legacy text-to-model
route permits at most one generation submission per revision, with a default total of one new
submission per run. The image route has a durable task-owned ledger per whole iteration, allowing
eight image-to-model submissions across assets by default
(`TRIPO_MAX_IMAGE_GENERATIONS_PER_ITERATION`). One approved input gets one submission.
After a polling timeout, later whole iterations query the original known Tripo task instead of
submitting or charging again. Approved concepts and downloaded bases are reused across rounds,
including when Blender failed before producing a usable export. An unknown submission result is
never retried blindly. Tripo defaults to a 20-minute total wait and 2-minute individual requests.
Credits,
authentication, rate limits, service errors, timeout, malformed output, download errors, and
quality gaps in the legacy route return a recorded `blender_direct` fallback. In the image route,
retain the stage GAP and complete the whole iteration. Cancellation or unconfirmed process
shutdown propagates to the worker instead of starting a fallback.

The image route sends `model=gpt-image-2` to the configured local
`/v1/images/generations` API. It never uses Tripo text-to-image. By default it reads the selected
provider's base URL and `OPENAI_API_KEY` from the worker account's global Codex configuration.
An explicit `MODELING_IMAGE_BASE_URL` override can use `MODELING_IMAGE_API_KEY_FILE`; the original
router credential is never forwarded to a different host. Keys remain outside the repository and
agent subprocess environment. Requests default to a 20-minute timeout, bounded by the task deadline
(`MODELING_IMAGE_TIMEOUT_MS`). The router may return a different actual image size; retain the
measured dimensions and review the returned pixels. Persist submission intent before the
synchronous call; timeout/interruption with an unknown result consumes that draft, and resume
cannot repeat the paid request. An unknown draft can be retried only in the next whole production
iteration, without reopening the consumed submission in the current iteration.

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

Technically usable output below its visual target is `DCC_PROVISIONAL`, with a coverage score,
the complete criterion review and repair instructions. Finish the current whole-game iteration
with that artifact after the local route retry budget. Passing assets are reused next round;
deficient assets start from the best retained source and may switch to available 3D generation
after another route assessment. A valid GAP is never resampled within the same asset attempt.
`NO_USABLE_ARTIFACT` records exhausted production without a technically usable export; it is
not an importable model. Continue with an explicitly documented temporary representation.

Original-reference research precedes fidelity-dependent modeling and records inspected local
images, source URLs and hashes. Retrieval blockers remain explicit provisional quality gaps.
The host passes engineering unknowns, author reports and up to 12 supplemental images to review;
author images alone cannot establish acceptance. Host FBX inspection measures proxy binding
names and produces identical-camera LOD comparisons. The original technical and visual targets
remain unchanged throughout provisional delivery and subsequent improvement rounds.

The UE 5.8 FBX/Interchange converter maps `auto_generate_collision=false` to disabling collision
import, including UCX. Keep it true, import normals/tangents, verify the exact convex hull count,
and explicitly import required LOD files. The checker waits for shader compilation before capture.
Complex skeletal UE import, custom pivot mapping and lightmap packing remain uncalibrated and
produce a required GAP; never replace their requirements with a static-asset PASS.
