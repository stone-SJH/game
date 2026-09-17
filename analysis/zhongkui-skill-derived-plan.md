# Skill-derived production plan

The skill source was installed from `gamedev-skills/awesome-gamedev-agent-skills` at commit `b105e1cf617adf0b68ed98790a716bbb60993179`. Yahaha3 now has 21 installed skills: six Unreal skills and fifteen cross-discipline skills. The machine-readable preflight input is supplied outside this repository; this note explains how the skills shaped its scheduling and acceptance model.

## Production stages

| Stage | DAG nodes | Skill decisions | Primary tools | Required result |
| --- | --- | --- | --- | --- |
| Freeze and decompose | `input-freeze`, `reference-shot-breakdown`, `scope-system-audit` | Preserve source hashes, sample the video, record unknowns, explicitly exclude dialogue/procedural features that are not evidenced | `ffprobe`, `ffmpeg`, JSON validator, event log | Frozen input contract, four-phase shot contract, scope contract |
| Project and asset planning | `project-bootstrap`, `style-bible-and-asset-manifest`, `asset-source-audit` | UE 5.8 target, C++ foundation plus Blueprint composition, inspect before inventing, manifest every asset, reject unqualified catalog contexts | Unreal Editor, C++/Build.cs, Assets4AI read API, Blender/MCP, provenance scripts | Compiling project skeleton, art brief, asset and conversion manifests |
| Playable blockout | `greybox-metrics-and-critical-path`, `player-gameplay-foundation`, `enhanced-input-and-accessibility`, `physics-and-collision-contract`, `camera-rig-and-shot-blocking` | Measure player metrics first; blockout before dressing; actions over raw keys; explicit collision channels; spring-arm collision, smoothing, look-ahead and additive shake | Unreal blockout, NavMesh, C++, Enhanced Input debugger, PIE, camera rig | Reachable four-zone blockout, compiled player, input contract, collision matrix and shot camera manifest |
| World and hero production | `environment-art-and-layout`, `materials-and-shader-response`, `hero-character-enemy-assets` | Validate topology, UVs, pivots, materials, collision and LODs; use authored wet/fire response; keep blockout composition and critical path | Blender/MCP, Unreal mesh/material import, Material Editor, shader compile | Dressed environment, material report, validated player/enemy/weapon/animation assets |
| Combat, feel and effects | `enemy-ai-and-encounter`, `game-feel-and-combat-feedback`, `niagara-fire-fog-embers`, `audio-and-ambience`, `hud-and-ui` | Blackboard/BT branches with observer aborts and bounded latent tasks; event-driven feedback; Niagara User parameters and fixed bounds; dB buses and variation; anchored event-driven HUD | BT/Blackboard debugger, AIController, Niagara editor, Blueprint/C++, MetaSound/Sound Cue, UMG | AI debug evidence, combat replay, Niagara report, audio mix report, HUD resolution report |
| Integration and proof | `integrated-sequence-and-capture`, `performance-profile-and-budgets`, `package-and-runtime-smoke` | Capture all phases at reference aspect; profile before optimizing; use UAT and run the packaged executable, not only a successful cook | Sequencer, Movie Render Queue, `stat unit`, `stat fps`, `stat scenerendering`, Unreal Insights, RunUAT | Video/stills with timestamps and camera transforms, measured performance report, runnable package |
| Autonomous decision | `autonomous-visual-and-structural-validation`, `final-artifact-bundle` | Objective gates plus 1-5 per-dimension score; no host approval; every artifact hash-linked to one revision | Asset scanner, reference scorer, hash validator, artifact packer | Sandbox PASS/FAIL report, evidence manifest and correlated final bundle |

## Scheduling rules

`preflight-read`, `asset-planning`, `project-foundation`, `level-blockout`, `gameplay-foundation`, `camera-and-combat`, `world-art`, `character-art`, `character-gameplay`, and `fx-audio-ui` are parallel groups only where their resource lists do not overlap. Any task holding `unreal:project-write` or `unreal:level-write` is serialized by the sandbox worker. Catalog and reference reads can run concurrently. Integration begins only after all runtime systems have accepted evidence.

Each node reports a result object before acceptance. The result must name every output, include the expected fields in `resultContract`, list evidence files, and include hashes. A failed criterion creates a new attempt directory and event; it cannot overwrite an accepted artifact. The final validator is deliberately a single-attempt decision node: it either emits a sandbox-owned FAIL with actionable reasons or allows final bundling.

## Discipline boundaries

Dialogue is out of scope unless the reference decomposition finds dialogue content. Save-system work is reduced to deterministic reset/checkpoint because the capture is a short iteration, not a progression game. Procedural generation may only provide seeded dressing helpers; the four-phase composition and pacing remain authored. The input, physics, camera, UI, AI, audio, shader and performance disciplines remain active because each is visible in the reference or required for a repeatable Unreal production.

## Why the plan is stricter

The original short preflight described the desired look but did not give a worker enough information to produce or reject intermediate artifacts. This plan makes each handoff explicit: what the node reads, which tool owns the work, what files it must write, how the result is checked, what resource it locks, and how a failure is retried. The host can observe the mirrored status, but it cannot approve a task or turn a process exit code into acceptance.
