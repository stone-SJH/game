# Knowledgebase

Current target: **Phase 1, internal testing with a limited invited audience**. Phase 2 is the later production launch. Accounts, fixed workers, reliable cancellation/heartbeats and the internal task workbench belong to Phase 1; cold start, shared pools, cross-worker restore and automated resource release belong to Phase 2.

| Document | Purpose |
| --- | --- |
| [Phase 1 implementation](phase1-implementation.md) | Actual repository implementation, local verification, outstanding work and rollout |
| [Phase 1 plan](phase1-http-pilot-plan.md) | Internal-pilot scope and acceptance gates; retains the original filename |
| [User/workspace design](user-workspace-worker-design.md) | Logical model, constraints and phased design; not all planned tables/features are implemented |
| [Architecture](controller-worker-architecture.md) | Shared boundaries and separately identified production target |
| [Worker modeling routing design](worker-modeling-routing-design.md) | Proposed modeling evaluator, asset reuse, Blender/Tripo routing, quality gates and failure fallback |
| [Modeling harness upgrade plan](worker-modeling-harness-upgrade-plan.md) | Verified Tripo China endpoint, selected Blender skills, headless MCP adaptation, asset QA and Unreal handoff rollout |
| [Modeling harness implementation](worker-modeling-harness-implementation.md) | Local skills and v2 contracts, real Blender/Tripo/Unreal validation evidence, calibration limits and deployment |
| [ECS bootstrap](ecs-controller-bootstrap.md) | Historical environment record and phase-specific infrastructure checks |
| [Phase 2 prerequisites](phase2-prerequisites.md) | Future production scope, not the current delivery checklist |

On 2026-09-16 the user reported a successful deployed HTTP toolchain smoke at `139.224.32.61`. The new account/protocol-2 implementation has local validation only; it has not replaced that deployed release. Prefer the implementation record and directory deployment runbooks over historical setup commands.
