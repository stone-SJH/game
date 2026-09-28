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

Resume this retained task through the normal controller continuation path on its
original pinned release. A changed worker release cannot silently migrate its
toolchain or budgets. The automatic backup fix applies to new tasks; never rewrite
an old task's pinned hashes to make a deployment appear compatible.

## Verification

`node --test worker/tests/modeling-blockout-evidence.test.mjs` covers final-author
cleanup, exact restoration, durable call reuse, legacy behavior, changed evidence,
damaged backup manifests, missing backups and Windows junction rejection. Its
pipeline fixture executes the real host blockout/final/check/accept flow with
injected author and Blender responses, then resumes without repeating authoring.

The incident recovery opened the real Blender checkpoint read-only and verified
all original evidence hashes. It did not rerun generation or Unreal acceptance.
On the Windows worker, all 227 Node tests (including eight recovery regressions)
and syntax checks for all 47 agent/tool JavaScript modules passed. The running
worker still matches the incident task's original pinned harness hashes.
