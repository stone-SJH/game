# Zhong Kui reference preflight

This is a local preflight package for a future sandbox-owned Unreal production. It does not start a cloud instance, connect to a sandbox, alter Yahaha2, or make a claim that the reference and the recreation are pixel-identical.

## Evidence and observations

The original visual evidence was reviewed outside this source repository. Its dimensions, hashes and analysis notes are recorded in `zhongkui-reference-manifest.json`.

The earlier inventory included additional screenshots that were unavailable. They remain documented as missing evidence; no replacement is inferred and no source file is modified.

The video samples support four production phases:

1. A third-person traversal through a narrow wet, rocky dead forest with exposed roots, boulders, grey-blue light and soft mist.
2. An approach to a body or enemy in a muddy stone clearing, with the pale-robed player and weapon readable at gameplay distance.
3. Combat in an open clearing framed by tree roots and layered rocks, with the first warm fire illumination entering the cool ambient scene.
4. Continued movement or combat through ground and tree fire, smoke and ember particles, wet-ground response, and strong warm/cool contrast.

The frame evidence includes a HUD. The preflight therefore treats this as a reference gameplay capture rather than silently converting it into a HUD-free cinematic.

## Quality interpretation

“The same quality as the original” is translated into a reference-bounded acceptance contract. The sandbox must compare each declared phase and score composition, environment/materials, character/enemy readability, lighting/color, fire/fog/embers, motion/camera and capture integrity from 1 to 5. Every dimension must score at least 4, objective checks must pass, and any critical deficit fails the global decision. This makes the requirement actionable without pretending that an automated test can prove literal pixel equality across different assets, render paths or engine versions.

The acceptance report must include the evidence frame, camera transform, timestamp, objective measurements, score rationale, failure reasons, project revision and file hashes. A process exit code or a host acknowledgement is not acceptance evidence.

## Current implementation assessment

The Yahaha3 control-plane scaffold already establishes the important ownership boundary: the host creates an immutable `hostTaskId`, the sandbox creates the `goalId`, compiles the plan, owns task execution and evidence validation, and mirrors the remote state back to the host. With the new `context` field, detailed reference and execution constraints survive plan compilation.

The main remaining implementation work for a future production task is to replace the deliberate `NEEDS_REPLAN` executor hold with a sandbox worker adapter that can run Unreal/Blender work, publish task leases and artifacts, and execute the quality report. The adapter must keep the host out of the acceptance loop. Asset catalog calls should be read-only and must record deployment context before an asset is bound; the currently exposed Assets4AI context is unspecified/Unity scanner data, so it cannot be treated as an Unreal delivery guarantee.

## Recommended refactor order

1. Keep the local trigger/status API and define a versioned remote goal envelope carrying host task ID, goal ID, immutable input hash, plan revision, lease token and artifact index.
2. Add a sandbox worker supervisor with resumable task leases, heartbeats, bounded retries, cancellation scoped to the remote goal, and an append-only event log. A worker should claim only a ready DAG node whose dependencies are accepted.
3. Split read-only planning and asset audit from serialized Unreal project writes. Asset lookup and reference analysis can run in parallel; level, material, animation and capture writes should use an explicit project lock.
4. Add an Unreal adapter that produces deterministic capture metadata, camera transforms, frame timestamps, build revision, performance samples and artifact hashes. Add Blender conversion only as a recorded asset pipeline step.
5. Implement sandbox-owned visual and structural validation. It should inspect the generated capture and project artifacts, score every dimension, and emit PASS/FAIL with reasons before the goal is mirrored to the host.
6. Add host observation endpoints for status, phase, selected artifacts and logs. Observation must remain optional and must not become an approval gate.
7. Add recovery tests for worker loss, duplicate delivery, stale leases, partial artifacts, invalid evidence hashes and resumed goals before running a new end-to-end remote task.

The concrete preflight input for the next task is supplied separately and is intentionally not submitted by this repository.
