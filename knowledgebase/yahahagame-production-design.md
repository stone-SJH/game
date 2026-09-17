# YahahaGame Production Design

Updated: 2026-09-16

## Decision

The worker should run Codex Astra with a project-local `yahahagame-production` master skill. The
master skill is an orchestrator: it converts a natural-language objective into a bounded,
checkpointed Unreal production plan and dispatches the existing `Disciplines` and `Unreal`
skills from `gamedev-skills/awesome-gamedev-agent-skills`. It must not duplicate C++, Blueprint,
Niagara, or packaging instructions.

The repository copy is at `skills/yahahagame-production/`. Pin the upstream skills repository to
commit `b105e1cf617adf0b68ed98790a716bbb60993179` when building a worker image. Update that pin
only after reviewing the routing and acceptance behavior.

## What the current system can and cannot do

The current controller already owns task/workspace/run identity, leases, heartbeats, cancellation,
artifact hashing, owner isolation, and final terminal decisions. The current worker creates an
empty workspace and only performs Blender and Unreal launch probes. It does not yet start a Codex
session, create an Unreal project from the objective, author assets/gameplay, package a runnable
game, or produce stage-level evidence.

The current UI can display task events, artifacts, images, and final reports. It has no stage view,
conversation/instruction route, pause/resume controls, checkpoint browser, retry/new-run action, or
revision history.

## Target architecture

```text
browser objective/instruction
        |
        v
controller: immutable revision + run + stage state + event log + leases
        |
        v
worker: isolated workspace + Codex Astra session + master skill
        |
        +--> selected Disciplines skills
        +--> Unreal 5.8 skills
        +--> Blender / Unreal / build / playtest tools
        |
        v
stage reports + evidence + checkpoints + package artifacts
        |
        v
browser timeline, previews, reports, package downloads
```

Codex is the production actor, but the controller remains the authority. The model cannot mark a
task completed directly, mutate controller state, or bypass a lease. The worker adapter translates
Codex output into validated stage events and uploads.

## Production stages

1. Intake and contract: normalize objective, platform, camera, genre, visual target, constraints,
   and acceptance criteria.
2. Project bootstrap: create `.uproject`, source/Config/Content roots, default map, build target,
   input baseline, and Blender working scenes.
3. Art direction and asset plan: create style brief, asset manifest, provenance policy, and an
   import plan before producing asset families.
4. Asset production/import: create or source meshes, materials, textures, animation, audio, and
   effects; validate pivots, UVs, collision, LODs, scale, and licenses.
5. Level blockout/traversal: establish player metrics, critical path, gates, pacing, camera shots,
   navigation bounds, and a playable blockout.
6. Gameplay foundation/input: implement player verbs, game mode, input mapping, interaction,
   restart/failure/success rules, and a minimal playable loop.
7. Camera/combat/AI/feel: add camera, enemy decisions, combat, hit feedback, physics tuning, and
   deterministic test scenarios.
8. World/materials/fx/audio/UI: integrate art, shaders, Niagara, audio, HUD, menus, and safe-area
   behavior at target resolutions.
9. Integration/build/playtest: compile, cook, run PIE and packaged smoke tests, capture logs,
   screenshots/video, and measure performance budgets.
10. Package/acceptance: package the declared platform, launch it, execute acceptance scenarios,
    hash artifacts, and write the final acceptance report.

Stages may run in parallel only when their declared resource locks and file dependencies permit it.
Project-writing stages are serialized. Each accepted stage creates a checkpoint and immutable
report; a failure creates a new bounded attempt.

## Required implementation increments

### P0: worker adapter and contracts

- Add the master skill and pin the upstream skill bundle.
- Replace the hardcoded worker probe with a Codex executor interface.
- Pass objective, revision, workspace root, stage manifest, tool paths, and acceptance criteria as
  a generated task context file.
- Require machine-readable stage reports and enforce workspace path boundaries.

### P1: real project bootstrap and vertical slice

- Add a deterministic Unreal project bootstrap stage and a Blender asset workspace.
- Give Codex a bounded tool allowlist for file edits, Blender, Unreal, build, capture, and tests.
- Produce one small vertical slice end-to-end before attempting a large game.
- Upload plan, workspace manifest, stage reports, preview captures, package, and acceptance report.

### P2: evented progress and browser observability

- Add stage/event/checkpoint tables or JSON contracts to the controller.
- Extend SSE and UI with stage timeline, current stage, progress messages, artifact previews, and
  explicit waiting/blocked reasons.
- Keep progress event-driven; never invent percentages from elapsed time.

### P3: pause, retry, checkpoint, and revisions

- Add idempotent pause/resume/retry/instruction routes.
- Pause only at safe stage boundaries or after confirmed bounded-command shutdown.
- Store immutable revision and attempt records; invalidate downstream stages on changed inputs.
- Fence uncertain work until the old process tree is verified.

### P4: acceptance hardening and cloud pilot

- Run packaged-game scenarios, not only editor launch or cook.
- Verify package hash, default map, input path, asset provenance, logs, and screenshots/video.
- Exercise worker disconnect, controller restart, cancellation versus completion, and checkpoint
  restore on the same worker.
- Only after these pass, run the bounded HTTP cloud pilot at `http://139.224.32.61/`.

## Open constraints

- Codex Astra invocation flags and authentication must be pinned to the installed worker CLI/API;
  do not guess them in the adapter. Make them environment configuration and log the resolved model
  name without credentials.
- A full game is too large for one unbounded model turn. The controller must enforce stages,
  budgets, attempts, and acceptance gates; the master skill must yield at each checkpoint.
- Unreal Editor and Blender can leave locks or child processes. Stop confirmation and workspace
  fencing are prerequisites for pause, retry, and recovery.
- Asset licensing/provenance and external catalog availability are acceptance inputs, not optional
  prose. Missing provenance blocks the relevant stage.
- Local-only checkpoints cannot justify destructive worker/VM release. Cross-worker restore remains
  a later durability feature.

## Suggested first real test

Use a bounded vertical-slice objective such as: create a small third-person UE 5.8 scene with one
player action, one enemy or interactable, one authored Blender prop, a HUD, a restart condition,
and a Windows Development package. Require the final report, package hash, launch capture, and
one reproducible playtest scenario. This tests the orchestration without pretending that a full
reference game can be generated reliably in one run.

## References

- Upstream router: https://github.com/gamedev-skills/awesome-gamedev-agent-skills/blob/b105e1cf617adf0b68ed98790a716bbb60993179/router/SKILL.md
- Upstream Unreal skills: https://github.com/gamedev-skills/awesome-gamedev-agent-skills/tree/b105e1cf617adf0b68ed98790a716bbb60993179/skills/unreal
- Upstream disciplines: https://github.com/gamedev-skills/awesome-gamedev-agent-skills/tree/b105e1cf617adf0b68ed98790a716bbb60993179/skills/disciplines
