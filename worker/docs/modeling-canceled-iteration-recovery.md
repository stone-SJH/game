# Canceled authors at an iteration boundary

A task deadline can cancel an author and confirm process shutdown in the execution
ledger, then propagate a bare abort to the outer pipeline. Older workers retained
that attempt as pending. A later Continue with a new revision then failed with
`An unfinished modeling attempt must resume in its original production iteration.`

The worker now archives a canceled author reservation after verifying its latest
durable call is failed, canceled, and confirmed stopped. This happens when handling
the cancellation and when loading retained state, before the iteration check.
The original iteration, call, deadline, counters, files and failure remain intact.
The archived output is not promoted to an accepted asset. Remaining author work
uses only the normal allowance; validation stages keep their own recovery rules.
An unconfirmed process, an explicit execution fence or any other unfinished
operation still blocks the transition.

For a retained workspace on an older release, pause autostart and stop the idle
worker. Use `migrate-workspace.mjs settle-pending WORKSPACE`, review the exact plan,
then apply with `--apply --expect-plan-hash HASH`. Verify the settlement preserves
the failed execution ledger, counters and all pending artifacts. Commit the repair
and complete the workspace migration plan/stage/apply/resume-check flow before
restarting through the installed autostart task. Do not edit iteration numbers,
clear execution journals, reset budgets or claim model acceptance from settlement.
