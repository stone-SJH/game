# User revisions and concept generation inputs

A controller-owned follow-up is reviewed once per immutable revision before ordinary
modeling repairs. The host records the cited instruction, exact superseded requirements,
before/after plans and independent review in `user-revision-<hash>.json`. The visible copy
is `project/plan/modeling-user-revision.json`. Technical contracts and unrelated assets
are preserved. Obsolete pending requests are archived with their original contents.
An ordinary agent repair cannot grant this authority or change the approved input.

This is an asset-level visual revision protocol, shared by characters, props, organic objects
and environment kits. Asset IDs, excluded terms, reference selections and superseded entries
come from each task's current instruction and plan; there are no built-in task IDs, character
names or prescribed replacement designs. Multiple assets may be revised together, while
unaffected assets remain unchanged. Receipts and refusals are scoped to their task workspace.
A plain Continue with no visual change preserves the existing inputs and pending repair work.
Technical contract renegotiation is outside this visual-input path: this mechanism cannot
silently change dimensions, rig requirements, budgets or engine acceptance to make a run pass.

Revised assets have an explicit `generationInput`: current visual prompt, visual
requirements, designated generation references and excluded terms. Historical requirements,
technical checks and comparison-only images remain evidence but are not appended to the
provider request. Research cannot silently replace this input. The final composed prompt,
including reference descriptions and draft repairs, is checked immediately before submission
and saved as `draft-<n>/generation-input.json` with its hash and reference evidence.

The excluded-term list is host validation configuration and is never submitted. Independent
input review receives the composed `initialProviderInputs` separately from that configuration
and archived history. This review does not certify visual fidelity or provider acceptance.
Supersession records contain only removed requirement-array entries; validation reports the
exact expected entries and unexpected values so bounded repairs can correct malformed output.

An input constraint failure makes no provider request. A confirmed provider content-review
rejection remains retained and blocks automatic resubmission of the same explicit input,
including after unrelated metadata changes. Neither input approval nor an approved concept
proves generation, rigging, import, runtime binding or package acceptance. Report host image
submissions separately from Tripo submissions and engineering-agent tool calls.

## Content review recovery

Image API `moderation_blocked`/`content_policy_violation` and Tripo error `2008` require an
input revision. Tripo classification follows its [v3 error reference](https://developers.tripo3d.com/en/docs/error-handling).
Network timeouts, authentication failures, credit shortages and moderation-service errors
are separate failures; they must not be guessed to be content rejections.

The host publishes `generation-input-required-<iteration>.json` through the existing artifact
channel. It includes affected asset IDs, stage/provider, the submitted prompt or image hash,
available request/trace IDs and error codes, plus a Continue template and revision options.
It does not invent the sensitive word, image region or copyright cause when none was supplied.
Retained legacy image receipts are read for diagnostics without rewriting their evidence.

Finish and preserve the current playable/provisional round and independent assets, then stop
automatic rounds with `GENERATION_INPUT_REQUIRED`. If packaging itself fails, retain its
failure alongside the input report. Do not run several identical rounds before telling the user.

The user may give a complete acceptable description, clarify which appearance obligations
it supersedes, or explicitly select different references/design scope. The normal host revision
flow reviews that instruction, builds a new input identity and tries it under the existing
budget rules. New user reference inventory is made available to the reviewer. Old failures
and spent reservations remain immutable; changed content is not rejected merely because its
asset ID has a prior failure. Unchanged effective input remains blocked despite metadata or
state-path changes. A rejected asset does not disable generation for unrelated assets.

There is no automatic provider switch, encoding trick, disguised resubmission or silent
design replacement after a content refusal. Legitimate input changes remain subject to the
provider's review; success is not guaranteed. Pure technical-contract changes are outside
the visual-revision protocol and must not silently waive the original acceptance contract.

Three unchanged package hashes and scores now stop with `PRODUCTION_STALLED` and
`production-stalled.json`, retaining iteration reports and deliveries. This is a no-progress
failure, not a claim that the iteration budget was exhausted or the requested asset shipped.

## Deploying to a retained task

These changes alter the pinned modeling harness. Commit and verify the worker release;
use `worker/tools/migrate-workspace.mjs` plan, stage, apply and resume-check with the exact
reviewed plan hash. Follow the worker maintenance/autostart procedure. Do not overwrite
historical pins, reset budgets, delete journals or hand-edit task/controller state.

After `READY_FOR_CONTINUE`, submit the user's scoped instruction through the normal
authenticated Continue action. A maintenance check alone is not a successful production
run. Inspect the new host disposition and actual generation-input receipt, then require
generated source hashes, rigged export, Unreal skeletal import, actual player binding and
a new tested Windows package before reporting the character replacement complete.
