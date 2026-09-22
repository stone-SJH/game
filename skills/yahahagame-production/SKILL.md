---
name: yahahagame-production
description: Orchestrate natural-language Unreal game production in a task-owned workspace. Use when a worker must plan, create assets and gameplay, integrate Blender and Unreal, report stage artifacts, validate a playable result, package it, or handle pause/resume, checkpoints, retries, and user-driven revisions. This skill coordinates specialized Unreal and game-development skills; it does not replace their engine-specific instructions.
metadata:
  short-description: YahahaGame production orchestrator for Unreal projects
---

# YahahaGame Production Orchestrator

You are the production lead for one task-owned workspace. The user provides an objective; the
workspace is new and may contain multiple `.blend` and `.uproject` files. You own the plan,
stage boundaries, artifact contracts, evidence, and acceptance decision. Specialized skills own
the implementation details.

## Non-negotiable rules

- Never ask the user for an existing `.uproject` or `.blend` path. Create and track project files
  inside the assigned workspace.
- Read the workspace manifest and current checkpoint before editing. Record every created or
  modified project file, tool version, asset source, license/provenance record, and hash.
- Do not call a stage complete because a command exited successfully. Require its declared
  outputs, validation evidence, and a stage report.
- Keep all writes inside the task workspace. Reject absolute paths, parent traversal, junctions,
  and untracked external project locations.
- Make one bounded stage change at a time. At a safe boundary, persist a checkpoint before
  starting the next stage.
- When a user changes the objective, create a new immutable revision. Do not silently mutate an
  accepted stage; invalidate only its dependants and explain the resulting rework.
- On failure, preserve logs and the workspace. Retry only with a recorded reason and bounded
  attempt count. On interruption, stop or verify the tool process before resuming.

## Operating loop

1. **Intake**: normalize the objective into player experience, target platform, visual direction,
   constraints, acceptance examples, and explicit unknowns. Ask only questions that block a safe
   plan; otherwise record assumptions.
2. **Plan**: write `plan/production-plan.json` and `plan/stage-manifest.json`. Define the critical
   path, dependencies, parallel-safe work, resources, tools, outputs, evidence, retry policy,
   and acceptance criteria for every stage.
3. **Bootstrap**: create the Unreal project and source tree, Blender working scenes, config,
   ignore rules, and `workspace-manifest.json`. Pin the detected UE version and tool versions.
4. **Produce**: execute stages in dependency order. Load only the specialized skills required by
   the current stage, then hand their results back to the manifest and stage report.
5. **Validate**: run focused checks after each stage, then build, package, launch, and playtest the
   integrated result. Capture machine-readable evidence plus screenshots/video/logs where useful.
6. **Review and hand off**: write `acceptance/acceptance-report.json`, publish the package and
   key previews as artifacts, and list known limitations. Completion requires every required
   criterion to be PASS.

## Stage template

Use these default stages and remove stages that the objective does not require:

1. `intake-and-contract`
2. `project-bootstrap`
3. `art-direction-and-asset-plan`
4. `asset-production-and-import`
5. `level-blockout-and-traversal`
6. `gameplay-foundation-and-input`
7. `camera-combat-ai-and-feel`
8. `world-materials-fx-audio-and-ui`
9. `integration-build-and-playtest`
10. `package-and-acceptance`

For a task that requests or implies 3D modeling, the worker harness runs a bounded modeling
sub-pipeline inside `asset-production-and-import` before the main production call. Read
[references/modeling-routing.md](references/modeling-routing.md) when that sub-pipeline is active.
The host evaluates existing licensed assets first, then chooses bounded Blender MCP authoring or
the optional Tripo-to-Blender path. A missing or failed Tripo provider is a recorded fallback to
Blender and never a reason to lower the asset acceptance gates.

Each stage report must contain: `stageId`, `revisionId`, `attempt`, `status`, `startedAt`,
`finishedAt`, `inputs`, `outputs`, `commands`, `toolVersions`, `evidence`, `warnings`, and
`nextStage`. A stage is `ACCEPTED` only when its report and evidence manifest are written and
all required outputs exist with hashes.

## Skill routing

Detect Unreal from `*.uproject` after bootstrap and use UE 5.8 skills for engine work. Route
concept work to the smallest applicable discipline skill, then compose it with the matching
Unreal skill:

- assets/art direction -> `create-game-assets`
- blockout/pacing -> `level-design`
- input -> `input-systems` + `unreal-enhanced-input`
- gameplay code -> `unreal-cpp-gameplay` or `unreal-blueprints`
- AI -> `game-ai` + `unreal-behavior-trees`
- VFX -> `unreal-niagara`; materials/effects -> `shader-programming`
- camera/feel -> `camera-systems` + `game-feel`
- HUD -> `game-ui-ux`
- audio -> `audio-design`
- save/progression -> `save-systems`
- performance -> `performance-optimization`
- packaging -> `unreal-packaging`

Read the selected skill body before acting and its references only when the stage needs them.
The orchestrator owns ordering and handoffs; the selected skill owns API and implementation
correctness.

## Control semantics

- **Pause**: stop scheduling new stages, finish or cancel the current bounded command, verify
  the process tree, write a checkpoint, then expose `PAUSED`.
- **Resume**: reload the last accepted checkpoint, verify hashes and tool compatibility, create a
  new attempt for the pending stage, and continue from the manifest.
- **Retry**: preserve the failed attempt, record the reason and repair plan, then run a bounded
  new attempt. Never overwrite evidence from an earlier attempt.
- **User revision**: append the instruction to the revision log, freeze a new plan revision, and
  invalidate downstream stages based on declared dependencies.
- **Crash/reconnect**: replay the journal only after confirming that no previous tool process is
  still writing. An uncertain process keeps the workspace allocation fenced.

## Required handoff files

At minimum, produce these files under the task workspace or run output:

```text
plan/production-plan.json
plan/stage-manifest.json
workspace-manifest.json
provenance/asset-manifest.json
stages/<stage-id>/stage-report.json
stages/<stage-id>/evidence.json
acceptance/playtest-evidence.json
acceptance/acceptance-report.json
```

The controller receives reports, evidence manifests, hashes, previews, logs, package archives,
and checkpoint manifests. It owns task state and completion; the skill never edits controller
state directly.

## References

- Read [references/production-contract.md](references/production-contract.md) for schemas,
  state transitions, checkpoint rules, and controller/worker event contracts.
- Read [references/skill-routing.md](references/skill-routing.md) when selecting specialized
  skills for a stage.
