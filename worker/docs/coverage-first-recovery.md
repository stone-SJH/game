# Coverage-first production and retained-task recovery

When the objective asks to replace all placeholders before refining detail, the
worker reads the saved-map instance inventory before authoring. Existing
`acceptance/active-material-dependencies-coverageN.json` inventories are usable
as repair evidence. New integration rounds write `acceptance/scene-coverage.json`
with the current task, workspace, run and iteration identity.

Coverage is separate from material binding and visual quality. It requires all
visible temporary instances to be replaced, non-default materials, Blender
sources, and hash-verified exports. Hidden collision helpers and explicitly
allowed distant silhouettes do not count as placeholders. An older inventory
guides repairs but cannot validate a new round. `plan/scene-coverage-status.json`
contains the host result and the outstanding instance-to-asset mapping.

Missing terrain outside a frozen core receives a separate contract. The coverage
planner must copy every existing asset exactly; additions use current contract
validation. During this phase each technically usable replacement is handed off
before further visual refinement. Existing unaffected candidates are reused.
Incomplete coverage prevents acceptance. Three completed rounds with identical
coverage deficits stop with `COVERAGE_STALLED`, regardless of package hash changes.
Improved coverage can become the retained best result even while its aggregate
acceptance score remains zero.

An explicit prohibition on external 3D generation takes precedence over organic
or character routing. Provider preflight, generation and generated-source reuse
are disabled for prohibited assets. Historical calls and files remain evidence.
Existing routes can transition to direct Blender only after pending work settles;
consumed attempts count against the remaining allowance. Changing a prompt or
adding references cannot refresh the same revision's asset author budget.

Revision repair accepts legacy zero tolerances and contracts with or without the
older optional traversal field. The original contract must still compare exactly.
Prompts stay within 1024 characters; additional obligations belong in requirements,
and full historical requests remain in the host journal. New contracts continue
to require positive tolerances.

For an older worker that left a failed author marked pending, use the explicit
offline settlement before planning the toolchain migration:

```powershell
# Only after the execution journal has settled and the idle worker is stopped.
# Set runtime/config/autostart.paused before intentionally stopping the worker.
node worker/tools/migrate-workspace.mjs settle-pending <workspace>
node worker/tools/migrate-workspace.mjs settle-pending <workspace> --apply --expect-plan-hash <reviewed-hash>
```

Settlement requires a FAILED execution call with `stopConfirmed: true`, refuses
live/unconfirmed work, saves the original state, and preserves execution bytes,
all attempts, per-revision allowances, stage deadlines and evidence. It archives
the pending reservation; it does not refund the failed attempt. Application and
recovery after interruption are idempotent. No controller state is edited by this
operation, and it does not trigger Continue.

Commit and deploy with the repository Git deployment scripts. Load the existing
worker configuration privately, then use the existing migration `plan`, `stage`,
`apply`, `resume-check` sequence with the reviewed plan hash. A successor epoch
overlays compatible toolchain bindings while preserving historical pins and
budgets. `resume-check` now verifies retained skill resources and checks that no
failed pending reservation remains. It resolves the same hash-verified recovered
references as production before checking skill membership; the initial intake
plan may not yet contain those references. It starts no research or generation.
`READY_FOR_CONTINUE` means these local
prerequisites passed; `realContinueValidated: false` explicitly records that the
user has not yet triggered a production run.

After the committed release and task migration are ready, remove the autostart
pause marker, trigger `YahahaGame-Worker-Autostart`, run
`register-worker-autostart.ps1 -CheckOnly`, and inspect a fresh monitor snapshot.
Confirm one worker, the intended commit and a fresh heartbeat. Preserve the task
for the user's manual Continue rather than starting production as a deployment test.
