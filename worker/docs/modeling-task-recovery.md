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
