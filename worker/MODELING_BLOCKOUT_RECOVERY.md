# Frozen blockout recovery

The final modeling author writes beside the previous `blockout/` directory. Those
earlier files remain frozen evidence even after final exports exist. The host now
copies every declared blockout artifact, preview, checkpoint and executed script
into the task's `modeling-state/tasks/<identity>/blockout-evidence/<attempt-hash>/`
before launching the final author. The saved pending stage pins the backup manifest
hash. Copies are independent files, not links to the working files.

At the final boundary and on resumption, the host verifies the entire backup and
all surviving originals. Missing working files can be restored only from bytes
matching their original SHA-256. Existing changed files, changed/missing backups,
path escapes, junctions and concurrent writers still fence execution. Recovery
records its intent and completed restorations in `recovery.json`; it does not reset
author attempts, validation calls, deadlines, requirements or quality outcomes.
Old pinned tasks without a backup retain their original integrity checks.

## Incident: task-dc865443-3ea2-4fce-a59b-38da8737ac7a

On September 28, 2026, the final `shrine-incense-burner` author completed its exports
but deleted `blender_direct-3/blockout`. Its retained final-author log records the
successful directory deletion at item 57. Post-author verification then stopped on
the missing `blockout/recipe.py`. The final author had completed its original call;
the host had not yet validated that final model's geometry or visual quality.

Six deleted files were recovered byte for byte, with every candidate matching the
previously recorded hash before restoration:

- `recipe.py`: literal recipe in the retained Blender MCP script, with its original
  Windows line endings.
- `source.blend`: the unchanged host checkpoint.
- `asset-manifest.json`: retained literal fields, the unchanged prior manifest and
  original measurements embedded in the checkpoint, including the original timestamp.
- `preview-report.json` and `checkpoint.json`: original completed execution results.
- `execution-recipe.json`: original MCP receipt and the host's JSON serialization.

The original 15 blockout evidence hashes and final author evidence pass. The asset
state and execution index retain their hashes, including the completed author call,
attempt count and deadlines. The restoration does not change the controller's
terminal task status or claim gameplay acceptance. Operator evidence is outside Git
at `runtime/diagnostics/blockout-dc865443/recovery-report.json`.

Resume this retained task through the normal controller continuation path. A changed
worker release cannot silently migrate its toolchain or budgets. The operator may
explicitly migrate this task with the bounded procedure below, after recovering and
verifying its original evidence. A release upgrade alone does not change task pins.

## Explicit continuation migration

`worker/tools/migrate-blockout-task.mjs` prepares a plan from the old and committed
new checkouts. It permits changes only to the blockout backup module, pipeline and
skill routing. Runtime settings, execution policy, validator hashes, skill locks,
requirements, deadlines and all retained state remain pinned. Active/unsettled
calls, changed evidence and unrelated harness changes reject migration.

The pipeline uses each existing asset's verified archived skill resources. Legacy
pending final stages keep their original prompt text, so a completed author call
is reusable under its original input hash. New blockouts receive the backup and
preservation instruction before final authoring.

On the Windows worker, load its existing environment configuration without printing
credentials, then use the committed new checkout:

```powershell
node worker/tools/migrate-blockout-task.mjs --workspace WORKSPACE --task TASK_ID --baseline-repo OLD_CHECKOUT --out PLAN.json
node worker/tools/probe-blockout-continuation.mjs PLAN.json NEW_OVERLAY_DIRECTORY
```

The probe retains the original logical paths and redirects writes to an isolated
overlay. It permits no new author, review, Blender or capability calls and stops at
the resumed final model's technical validation boundary. It verifies that all live
task-state bytes remain unchanged. This proves continuation compatibility; it does
not claim the pending model passes technical or visual validation.

After a successful probe, create `runtime/config/autostart.paused`, verify the worker
is idle with no allocation or execution journal, and stop only that idle agent.
Switch the deployment checkout to the plan's exact commit, then run:

```powershell
node worker/tools/migrate-blockout-task.mjs --apply PLAN.json
worker/deploy/deploy-worker.ps1 -RepoRoot REPO -WorkerRoot RUNTIME -CheckOnly
worker/deploy/deploy-worker.ps1 -RepoRoot REPO -WorkerRoot RUNTIME
```

The apply command requires maintenance, no agent/journal and the exact committed
release. It records the original pin bytes and intent outside Git before changing
only their harness hash arrays. All other state JSON hashes must remain unchanged.
An interrupted apply can be rerun using the same plan. Preserve the plan and audit;
do not reset a task or discard its execution store. Remove the pause marker, trigger
`YahahaGame-Worker-Autostart`, and check its registration and a fresh worker monitor
snapshot. Use the normal controller continuation action for the original task.

## Verification

`node --test worker/tests/modeling-blockout-evidence.test.mjs` covers final-author
cleanup, exact restoration, durable call reuse, legacy behavior, changed evidence,
damaged backup manifests, missing backups and Windows junction rejection. Its
pipeline fixture executes the real host blockout/final/check/accept flow with
injected author and Blender responses, then resumes without repeating authoring.

`worker/tests/blockout-task-migration.test.mjs` covers bounded and idempotent pin
migration, original budget and completed-call preservation, rejection of active
calls and changed evidence, and reuse of archived skills after installed resources
change. The incident recovery opened the real Blender checkpoint read-only and
verified all original evidence hashes. It did not rerun generation or Unreal
acceptance. Keep live probe and deployment results in runtime diagnostics.
