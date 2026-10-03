# Completed exports after an author timeout

A final author can save its source and exports before the host deadline stops
the conversation. A rejected optional cleanup command in stderr does not explain
the terminal result when the process record says `timedOut: true`.

The worker classifies that result as an author timeout. It preserves the failed
execution record and consumed attempt, then checks whether the latest direct
Blender final has complete exports, confirmed stopped processes, unchanged
executed scripts and frozen blockout evidence. Such outputs enter
`TECHNICAL_PENDING`; this is not acceptance. The original technical and visual
validators run before a candidate can be used. Existing validation reservations
are never reopened and author deadlines are never extended.

Recovery currently covers final `blender_direct` attempts only. Canceled calls,
incomplete exports, unconfirmed shutdown, modified evidence and already reserved
validation calls do not qualify. Optional caches remain in place. Policy-denied
cleanup must not be retried through another shell or tool.

For retained tasks, stop the idle worker under the autostart maintenance marker,
verify the outputs without editing task state, commit the tested release and
use the workspace migration plan/stage/apply/resume-check flow. Check the active
epoch and retained skill bindings before restarting. A successful independent
technical probe does not replace the task's visual review or Unreal validation.
