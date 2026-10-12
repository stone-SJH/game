# Prompt-driven continuation after cancellation or failure

Continue edits the existing project in place. Partial source files, failed builds and
unfinished scene edits are normal repair inputs for the next production agent. There is
no per-round project clone, automatic project rollback or deletion of the failed attempt.

The recovery invariant is that a fresh controller-owned instruction reaches the relevant
repair/review entry point. A retained host question, rejected proposal or interrupted
stage must not permanently reject every future instruction merely because it exists.
The worker preserves original evidence and consumed budgets throughout recovery.

## Host state recovery

- A canceled controller question can remain in the worker's decision journal. A new
  revision's Continue text is reviewed as a free-text answer to that question against the
  current plan. A bare Continue still cannot approve a design change or resubmit rejected
  generation input. New questions in the current revision remain binding.
- Once an answer is reviewed, a failure to construct the host's modeling revision remains
  a host repair failure. It does not become another request for user authorization.
- Obsolete requirement wording can be reconciled with an existing technical contract as
  described in [modeling-generation-input.md](modeling-generation-input.md). The original
  rejection remains immutable, the corrected proposal is reviewed independently, and a
  later controller revision can submit another scoped instruction after a rejected repair.
- Technical/visual validation may cross into a later iteration when the original author
  has finished, the execution ledger is settled and retained artifact hashes still match.
  It resumes the original attempt with the same validation keys, calls and deadlines.
  Authoring is not repeated or refunded. Traversal-plan evidence keeps its original run
  location so moving to a new run does not change a durable validation input.
- An incomplete or malformed production plan/manifest pair can be repaired by the normal
  production agent when a new follow-up arrives. The host first archives the exact input
  bytes and findings, retaining all recoverable stage IDs. It leaves the project files in
  place and charges the normal production attempt. Full plan and stage acceptance checks
  still run afterward. Read-only migration preflight remains strict.

Same-revision retries keep their durable limits. A new user revision uses only the budget
granted by the controller. Recovery never deletes a failed ledger, edits toolchain pins,
converts GAP to PASS, or clears a provider refusal. A previous successful delivery is not
acceptance of the current instruction.

The worker must still stop for an unconfirmed live writer, foreign task ownership,
changed immutable evidence or an incompatible pinned toolchain. Those conditions need
verified process/toolchain recovery; interpreting a prompt as permission to ignore them
would conceal the actual problem. They are distinct from a stale host requirement or
half-written production metadata.

## Regression coverage

Run the worker tests for `modeling-user-revision`, `modeling-requirement-repair`,
`modeling-user-decisions`, `modeling-maintenance`, `modeling-review`,
`modeling-execution` and `production-plan-resume`. The continuation probes cover new
prompts after rejection/cancellation, interruption after activation, cancellation during
both validation phases, malformed/missing plan files, unchanged budgets and refusal of
unsafe evidence. Review/provider responses are fixtures; these tests do not certify
provider content approval or actual asset/engine quality.

This changes the pinned worker harness. Deployment to retained tasks still requires a
committed release and the repository workspace migration plan/stage/apply/resume-check
flow. Code validation alone is not deployed task readiness.
