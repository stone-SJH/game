# Natural-language engineering verification — 2026-09-27

## Failure and repair

Task `task-4f73a2b2-7202-41dd-b084-815fb54b95f0` produced a structurally valid
16-asset V2 draft, but `shrine-architecture-kit` required passage verification with
`traversal:null`. Intake instructed the model to leave unspecified metrics empty, while
the next gate required explicit capsule dimensions and local paths. No planning stage
resolved that gap. This was not a timeout.

Generated V2 drafts now enter bounded engineering planning before authoring. The planner
records project design choices for missing capsule, dimensions, pivot and paths; preserves
supplied dimensions and technical obligations; and assigns implementation/verification for
every original objective clause. Final strict model checks remain mandatory. Reference-game
facts that research cannot establish remain explicit acceptance obligations.

The audit also corrected:

- Uploaded references were absent from intake: verified text/images now reach both planning
  calls and their evidence hashes are retained.
- Ordinary natural-language quality requests could skip independent quality review.
- Quality review could omit or duplicate requested criteria, report PASS without evidence,
  or omit the actual scene image. Large asset plans could exhaust the evidence budget before
  the screenshot was attached. Criteria IDs and nonempty evidence are now checked and the
  actual image is prioritized.
- Restarting a task overwrote accepted stage records and attempt counts with PENDING entries.
  Resumption now retains stage history and updates only the run envelope.
- Code-only V2 requests now retain objective coverage through engineering and final acceptance.

## Automated and engine checks

Tests run on the actual Windows worker in an isolated Git worktree. All generated artifacts
are outside Git. Evidence root: `D:/StoneWorker/modeling-v2-audit/engineering-20260927`.

| Check | Result | Evidence |
| --- | --- | --- |
| Full Node worker suite | 136/136 passed, including complete host handoff and reference propagation | `node-tests.log` |
| JavaScript syntax | 33 agent/tool modules passed | Console check |
| Windows Git deployment tests | Passed | `deployment-tests.log` |
| Python traversal geometry | 6/6 passed | `python -B worker/tests/modeling-traversal.py` |
| Actual Blender 5.2.1 technical defect injection | 16/16 passed | `v2-gates/gates-report.json` |
| Actual Blender retained doorway and blocked-door checks | 12/12 passed | `traversal-dcc/traversal-gates-report.json` |
| Actual Unreal 5.8.2 capsule sweeps | 6/6 passed, asset/map hashes unchanged | `traversal-unreal.json` |

The first Unreal probe used a different imported fixture from its DCC request and correctly
returned GAP for mismatched hull geometry. Re-running with the matching retained project
passed clear passage, thin blocker, translated/rotated instance, mirrored instance, disabled
queries and restored passage. The mismatch was not bypassed or reclassified as a pass.

## Live model and production probes

Every probe uses a new task identity and an isolated workspace. Original task state, budgets
and artifacts are preserved. `worker/tools/modeling-intake-probe.mjs` retains requests,
responses, execution state, process logs and `probe-report.json`; `--mode production` runs
the complete local harness without publishing to the controller.

- Original 16-asset draft replay at `engineering-intake-live-srfoNo`: failed with upstream
  HTTP 503 on both bounded calls; source context unchanged. Failure evidence is retained.
- Fresh Chinese room/doorway request at `engineering-intake-live-U7mREa`: passed in 345.5 s;
  3 assets, 2 traversal contracts, all 3 objective clauses retained. Explicit door dimensions
  remained unchanged. The first engineering response tried to change a frozen LOD requirement;
  validation rejected it and the second bounded response corrected it without authoring.
- Original 16-asset draft retry at `engineering-intake-live-B936jO`: passed in 908.8 s;
  all 16 assets and 4 objective clauses retained, 7 complete traversal contracts, original
  source context unchanged. A zero-thickness water surface was rejected on the first response
  and corrected in the second bounded call.
- Complete UI-game probe at `engineering-intake-live-EdZ3fA`: intake and engineering passed;
  production encountered upstream HTTP 503. Its next iteration correctly stopped because
  this development worktree changed during the probe. No packaged game was accepted. This
  is an invalid full-production verification run, retained as evidence, not counted as a pass.
  Further production verification must run from an immutable committed release.

Probe directories above are under `C:/Users/stone/AppData/Local/Temp/`.

## Release and continuation

The default intake and engineering timeout remains 20 minutes per call, at most two calls
per stage, clipped by the task deadline. Other review budgets are unchanged.

Existing failed tasks retain their pinned release and consumed budgets. This change does not
silently reset them or migrate them onto a new toolchain. Test the repaired workflow with a
new task; continuing an old pinned task requires its original release or a separately tested
migration. No task artifacts or execution journals are cleared by this repair.
