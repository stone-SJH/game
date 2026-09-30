# Modeling state recovery

Large per-asset state uses a protocol 3 atomic index and hash-checked immutable
payloads. The in-memory model remains protocol 2. Old workers reject the new
index; rolling back code alone after migrating a task is not supported.
The generic JSON limit stays at 2 MiB. Legacy state has a scoped 64 MiB reader,
each external field is bounded at 32 MiB, and full validation evidence is kept.

## Offline recovery of an interrupted first iteration

Use worker/tools/modeling-task-recover.mjs. Its default mode is a read-only
preview. Supply --workspace, --task-id, --workspace-id, --from-repo (the exact old
clean checkout), and --worker-root. Load the worker environment without printing
credentials. Review the preview and run worker/tools/modeling-recovery-probe.mjs
with positional arguments <workspace> <new-copy> <old-checkout> against a
disposable copy before applying. The probe uses real retained evidence and
refuses any new author, reviewer or provider call.

The migration only supports tasks with no completed production rounds and no
pending or unconfirmed modeling operation. Runtime configuration, models, policy,
validators and asset requirements must match. Research references may differ
between old attempts only when their original bytes and complete asset identities
can be verified. All old candidates are preserved; each asset resumes from its
highest-scoring usable candidate, with GAP status and actual score unchanged.

Commit and push the tested release. Verify the worker is idle with no queued job
or execution journal, create config/autostart.paused, and stop that idle worker.
Run the same recovery command with --apply. It requires a clean target checkout,
the maintenance marker, no journal and no running worker. The backup under
<workspace>/recovery/<id> includes original locks, state and iteration ledgers.
The migration retains all stage calls, deadlines and attempt counters. It joins
the interrupted production ledgers by adding consumed attempts, writes first-round
handoffs, updates only the explicitly verified harness hashes in locks, and writes
recovery.json as the final commit point. Original asset files are not changed.

If interrupted before the backup report says COMMITTED, keep maintenance active.
Compare migration.json and its hashes, restore only the listed originals from
that backup, and remove only the incomplete recovery manifest/new iteration ledger
after review. Never delete the original execution journal or reset stage budgets.
Extra immutable payloads may remain safely. Retain the failed backup separately
before a reviewed reattempt; do not blindly replay an incomplete migration.

Deploy with worker/deploy/deploy-worker.ps1, update and verify the autostart task,
remove the maintenance marker, and verify one registered idle worker at the exact
commit. Check restored candidate hashes, payload hashes and consumed budgets.
The operator can then select Continue on the original task. The recovered first
iteration finishes delivery and scoring before another modeling repair round.
Subsequent specification revisions still invalidate the affected recovery mapping.
Recovery does not relabel incomplete assets or visual gaps as accepted results.

## Paused task upgrade to reviewed image modeling

For an already recovered task with completed deliveries, use
worker/tools/modeling-task-upgrade.mjs. Supply the same workspace/task/source-release
arguments as recovery, plus --report outside the repository. Default is read-only preview.
This separate migration requires settled modeling calls and no pending asset operation;
it does not join, replace or reset any production ledger. Runtime model/CLI settings,
stage policies, geometry validators, original requirements, skill resources and retained
artifact hashes must match. Only the new GPT Image 2 configuration and explicitly verified
harness hashes change in toolchain locks.

The preview verifies completed snapshots and current candidates, records every consumed
attempt and plans image-route activation for detailed characters. Assets already started
in the current whole iteration defer that route until the next iteration. Existing scores,
earlier routes, budgets, execution history and all source assets remain retained.
Recovered assets keep their verified reference set in subsequent iterations, including
an empty reference set. Automatic research cannot silently append images and change
their skill lock or attempt identity; an explicit specification revision still permits
new research. Concept generation uses the retained requirements and references.

Run worker/tools/modeling-toolchain-upgrade-probe.mjs with positional arguments
<original-workspace> <new-disposable-workspace> <old-release> first. It tests the copied
migration, verifies the next production attempt continues its counter, and invokes the real
pipeline up to the next external stage with all paid/author operations replaced by a stop.
The original workspace remains unchanged.

After tests pass, commit the release, pause autostart and stop the verified idle worker.
Use --apply only under maintenance; the command enforces no execution journal or worker
process. It backs up every original lock, asset state, recovery identity, execution ledger
and production ledger under recovery/toolchain-<id>, then writes upgrade.json as PREPARED
and finally COMMITTED. State payloads are immutable and remain available for rollback.
If interrupted, keep maintenance active and restore only the changedPaths listed in that
backup after comparing hashes; do not replay a partially applied upgrade or clear budgets.
Deploy the exact committed Git worktree, update autostart registration and verify the
idle worker before the operator selects Continue.

### Include Unreal when upgrading a recovered task

The upgrade also covers the task/project-specific lock in `modeling-state/engine-policy`
and verifies its independent execution ledger in `modeling-state/engine`. All existing
engine call IDs, deadlines, consumed allowances and immutable result evidence stay intact.
It checks the actual Unreal executable hash and rejects unfinished/unconfirmed engine
calls before writing any lock. An engine ledger without its pin is an integrity error.

A harness-only upgrade may retain identical runtime settings. To repair a previously
omitted engine migration, pass `--from-repo` for the current task release and
`--engine-from-repo` for the exact older clean release still pinned by Unreal. Both source
identities must match their stored locks; the only allowed runtime addition is the initial
reviewed image configuration. Existing image settings cannot change through this command.
Load the normal worker environment, including `UNREAL_CMD`, for preview and apply.

The copy probe accepts the older engine release as its optional fourth positional argument.
It first reproduces the old Unreal lock rejection, then upgrades the copied task and invokes
the real Unreal validation orchestration with retained exports, mappings and project content.
The external engine command is replaced with a controlled technical GAP: this proves the
validator can pass the migrated lock, preserve earlier calls, and return `ENGINE_PROVISIONAL`
instead of terminating the round. It does not claim a fresh Unreal quality pass or launch a
paid call. Newly generated concept images and Tripo bases are hash-checked and preserved too.

## Upgrade recovered workspaces to revision-aware releases

Use worker/tools/migrate-workspace.mjs plan|stage|apply|resume-check for the
workspace-iteration release. The online plan fences controller dispatch and binds
the exact committed worker and runtime. Review its mappingReady result before
staging; do not delete unmatched ledgers or change their attempt counters.

The migration recognizes objective-based legacy ledgers, revision-based ledgers
created by a failed first run after deployment, and shared recovered ledgers.
Recovered branches require the retained recovery identity and hash-verified
delivery reports whose task, workspace, iteration and run match controller
revision records. Multiple revisions may share that original recovered ledger;
two different ledgers may not claim the same revision. Native revisions retain
their revision-wide modeling budget and existing stage sequence after migration.

Pause autostart, verify IDLE/empty queue/no journal, and stop the idle worker before
staging or applying. Pin the current CLI/configuration with
worker/deploy/pin-worker-runtime.ps1 before creating the final plan when the
worker still uses a mutable global installation. Verify that runtime separately;
never copy credentials into Git or print configuration contents. Stage a verified
rollback snapshot, apply with the exact reviewed plan hash, and run resume-check
from the committed deployment. Compare all original ledger/pin hashes and consumed
budgets, restart via the Git deployment workflow, restore autostart, and verify a
fresh monitor snapshot. Leave the task for the operator to Continue; readiness
verification is not a production attempt or a quality acceptance result.
