# User revisions and concept generation inputs

A controller-owned follow-up is reviewed once per immutable revision before ordinary
modeling repairs. The host records the cited instruction, exact superseded requirements,
before/after plans and independent review in `user-revision-<hash>.json`. The visible copy
is `project/plan/modeling-user-revision.json`. Technical contracts and unrelated assets
are preserved. Obsolete pending requests are archived with their original contents.
An ordinary agent repair cannot grant this authority or change the approved input.

Revised assets have an explicit `generationInput`: current visual prompt, visual
requirements, designated generation references and excluded terms. Historical requirements,
technical checks and comparison-only images remain evidence but are not appended to the
provider request. Research cannot silently replace this input. The final composed prompt,
including reference descriptions and draft repairs, is checked immediately before submission
and saved as `draft-<n>/generation-input.json` with its hash and reference evidence.

An input constraint failure makes no provider request. A confirmed provider content-review
rejection remains retained and blocks automatic resubmission of the same explicit input,
including after unrelated metadata changes. Neither input approval nor an approved concept
proves generation, rigging, import, runtime binding or package acceptance. Report host image
submissions separately from Tripo submissions and engineering-agent tool calls.

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
