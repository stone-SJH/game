# V2 modeling internal recovery

## Reported failure

Task `task-91cb10ca-47df-4fce-afd2-4bc96c6f3985` failed before any model authoring.
Both intake calls completed in about three minutes, then failed semantic validation. This was
an internal protocol misunderstanding, unrelated to missing user requirements or the timeout.

The first draft used `maxTriangles=120000` and `lodTriangles=[120000,60000,30000]` for its modular
kit. The contract uses `maxTriangles` for LOD0 and the array for LOD1 onward, so the correct
representation is `[60000,30000]`. All six assets in both responses repeated this mistake.
The old repair prompt carried only “LOD budgets must decrease from LOD0”, without the preceding
response, asset identity, field, actual values, or LOD indexing convention. The second call
regenerated the asset list, changed IDs/budgets and repeated the error.

There was another defect: a missing traversal contract threw before the remaining checks, so
draft intake ignored that exception and also missed later LOD/profile defects on those assets.
The first draft's glider promised sockets/LODs under `glb-static`, an unsupported handoff.
The old passage detector also matched any use of “traversal”, including a held glider's ability
description. Static passage requirements now require passage intent; engineering still owns
semantic classification of room shells and doorways. Incomplete generated engineering receives
its remaining internal repair call instead of stopping immediately on `CONTRACT_INCOMPLETE`.

Original evidence remains in workspace `workspace-ea978dd7-0404-4323-8c17-e79d9ae87633`, run
`run-7a4ce202-54f7-4587-8cc1-dbea2edde235`, plus the task's `modeling-state` execution record.
No original execution state, budgets, or pinned toolchain are migrated by this fix.

## Ownership and flow

```mermaid
flowchart TD
  U[Objective and verified references] --> I[Intake agent: draft assets]
  I --> V[Host: schema and contract checks]
  V -->|Unambiguous LOD0 representation| N[Record lossless normalization]
  N --> V
  V -->|Repairable internal findings| R[Same agent: retained response and all findings]
  R -->|Original bounded stage budget| V
  V -->|Valid draft with engineering unknowns| E[Engineering agent: metrics and requirement owners]
  E --> C[Host: frozen constraint and complete contract checks]
  C -->|Invalid internal handoff| ER[Engineering repair with retained evidence]
  ER --> C
  C --> A[Route and author: blockout then final]
  A --> D[Blender technical and visual gates]
  D -->|Real quality GAP| A
  D --> UE[Unreal import and runtime gates]
  UE --> P[Integrated playtest and packaged acceptance]
```

| Finding | Internal owner and handling |
| --- | --- |
| Exactly repeated LOD0 followed by valid reduced budgets | Host draft adapter preserves all numeric budgets, retains raw JSON, writes normalization evidence. No extra model call. |
| Invalid generated JSON, profile or LOD relationships | Responsible review/planning agent gets the retained response and structured asset/field findings. No regeneration of a schema-valid draft or removal of valid constraints. |
| Unspecified controller capsule, paths or dimensions | Engineering agent makes explicit design decisions, preserving supplied measurements and objective coverage. |
| Valid visual GAP or failed measured geometry | Author receives actual defects; existing author repair budgets apply. Validation must pass again. |
| Transient invocation failure | Same stage retries within its original call/time allowance. No new author attempt for a review outage. |
| Integrity mismatch, cancellation, unconfirmed process stop | Stop/fence immediately; preserve evidence. These cannot be repaired by resampling model output. |
| Internal recovery budget exhausted | Report a diagnosed internal generation/service failure. Do not claim the user's objective is incomplete or ask them to repair generated contract fields. |

Intake and engineering still have at most two calls each, twenty minutes per call by default,
clipped to the task deadline. Continuation never creates a new repair budget. Review schema
repair applies to routing, engineering and visual reviews too; an already valid GAP is never
treated as invalid JSON and retried for a more favorable verdict.

## Evidence and verification

Every review call retains `*-request.json`, the original `*-response.json`, and
`*-validation.json`. A normalized draft also gets `*-normalized.json`. Failed schema calls
persist the raw response's path/hash and structured findings in `execution.json`; the next call
verifies the hash before using it. Request evidence records which failure it repairs.

Regression tests cover exact LOD0 normalization without data mutation, ambiguous budgets,
findings previously hidden by missing traversal, multi-asset/profile repair with the preceding
response, protection against dropping assets/LODs/requirements, resumed accepted results,
unchanged durable budgets, explicit-spec strictness and tampered repair evidence.
Engineering findings also include every changed frozen field and its original value. Known
pivot modes retain their exact representation, including null coordinates; filling those nulls
is not required to define an origin. Repair protects valid vector/LOD entries and every unique
required socket/animation name.

Windows regression results: 175 Node tests, syntax checks for all 37 agent/tool modules,
6 Python traversal tests, deployment tests, and all 11 autostart tests passed. Actual Unreal
loading and packaged launch passed on retained project copies at
`C:/Users/stone/AppData/Local/Temp/engineering-intake-live-RVG7Yt`.

Use `node --test worker/tests/*.test.mjs` and the isolated intake probe to verify a retained
failure. `--draft` supplies only the first response; any required internal repair uses a real
model call. The source task stays unchanged and the probe uses a new execution identity.
