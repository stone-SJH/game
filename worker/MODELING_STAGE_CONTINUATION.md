# Modeling V2 stage continuation

Internal stage failures are retained as scored gaps. They do not authorize global failure.
The implementation keeps the existing frozen requirements, durable calls and task deadline.

| Stage | Exhausted or invalid internal result |
| --- | --- |
| Intake / engineering | Existing PLANNING_PROVISIONAL handoff preserves raw responses and objective. |
| Reference research | Two durable calls per completed round; persist blocked assets and diagnostics, reuse verified references. |
| Blender capability discovery | Two durable calls per round; unavailable assets become NO_USABLE_ARTIFACT. |
| Technical checking / author reports | Keep the previous verified candidate or record an unusable-asset gap; continue other assets. |
| Visual review | Existing DCC_PROVISIONAL handling retains usable output without invented PASS evidence. |
| Internal model revision | Preserve raw request and base plan, repair twice per round, queue later additions without overwriting unresolved requirements. Commit outcomes before updating the base plan for safe resume. |
| Preview / checkpoint resume | A confirmed canceled call consumes its original attempt and allows the next author allowance. |
| Optional author pictures | Omit oversized/non-file pictures with diagnostics; keep other evidence. |
| Production / engine / stage review | Assess every independent stage, snapshot and score the round; hard-failure text is evidence, not authority. |
| Publication | Retain immutable bytes and a pending queue; retry required uploads independently from production. |

A missing/nonlaunching package is RETAINED_INCOMPLETE with score 0, never an accepted or
playable delivery. In a live worker, essential delivery continues past a quality cap until
the required result exists or the authoritative task deadline/cancellation intervenes.
Standalone probes may return incomplete evidence at their configured cap for inspection.
Unreal technical and visual review budgets belong to the production iteration. Resuming
the same round reuses its original calls and captures; a completed new round permits a new
review allowance. One asset's failed engine review does not suppress other asset reviews.
Selection of the retained best result prefers a complete publishable package before score.

Only explicit cancellation, unconfirmed shutdown, concurrent writers, confirmed changed/missing
frozen evidence, or changed pinned policies/toolchains fence execution. Transient hash reads
retry three times and retain EVIDENCE_UNAVAILABLE separately from an integrity mismatch.

Publication recovery is worker-local: each queued artifact has an immutable outbox copy,
checksum and attempts. HTTP 422 cannot rewrite PASS to FAIL. The live lease remains active
while required uploads retry; optional artifacts retain their pending diagnostics. A completed
iteration and its quality are independent of network availability.
Required-upload retry does not wait for optional evidence backends to recover.
The selected playable iteration's complete package archive is a required upload. If an
earlier archive operation failed, retry archiving its retained snapshot independently of
production before completing the live task. Production is not rerun for a publishing outage.

Verification uses isolated Windows temporary workspaces and injected tool/service failures.
Run `node --test worker/tests/*.test.mjs`; the new coverage includes multi-asset continuation,
same-round budget preservation, next-round recovery, invalid revision repair, two-round
production, required-upload retry, and a local HTTP controller returning 422 then accepting.
These tests do not validate new Blender geometry or live Unreal rendering. No running task
should be used as a test fixture or moved to this changed toolchain.
