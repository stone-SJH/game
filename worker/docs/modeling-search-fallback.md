# Modeling resource search fallback

The worker can acquire an existing licensed image or model when an identified generation
infrastructure failure prevents progress. `modeling-search-fallback.mjs` uses the existing live
research reviewer, with workspace output restricted by the research request to its acquisition
directory. No additional API key is required.

## Flow and evidence

1. Image generation remains the primary route. After an eligible service failure, search an
   existing image and apply the original independent five-criterion concept review. Only an
   approved image is submitted to image-to-3D.
2. If no image was acquired, or the 3D service fails, search up to three existing GLB models.
   Inspect each candidate using Blender, then refine it through the existing reuse route.
3. Apply unchanged modeling contracts and DCC/engine acceptance. A search hit alone cannot
   produce `DCC_READY` or `ENGINE_READY`. Visual rejection is a quality gap, not a service outage.

Acquisition accepts public HTTPS sources and asset-specific CC0-1.0, CC-BY-4.0 or CC-BY-3.0
licenses. Retain original bytes, author, title, full attribution, page/license evidence and
SHA-256 hashes. Models must be self-contained original GLB 2 files, at most 150 MiB. Images
must be PNG/JPEG/WebP, at most 20 MiB; normalize to a 256..4096 PNG without changing appearance.
Archives, account/payment downloads and unclear licenses are unsupported and remain gaps.

Records live under `art/sourced-assets/<asset>/<input-hash>/`. An acquired source is hash-checked
and reused across revisions; a failed search is retained per revision to prevent round-by-round
search loops. Search failure completes the current asset with an explicit gap so other assets can
progress. Search never clears generation request state, creates a replacement paid task, refunds
author attempts or changes task toolchain pins. A searched model shares the already-consumed
author allowance. Exhaustion retains the best candidate and defects for later scoped revisions.

## Refusals and execution fences

Only enumerated infrastructure reason codes trigger search. A generic HTTP 400, unknown failed
provider task, or content-policy rejection cannot be assumed to be an outage. Explicit image
rejections retain `IMAGE_INPUT_REJECTED` and require changed acceptable inputs; later service
failure must not turn that same rejected request into a search. Cancellation, unconfirmed process
termination, corrupted evidence, exhausted machine resources and original external-source
restrictions are preserved.

## Verification and deployment

Run `node --test worker/tests/modeling-search-fallback.test.mjs
worker/tests/modeling-image-first.test.mjs` (one command line) for acquisition validation,
resume, independent concept review, model refinement, paid-state retention, author limits,
moderation and cancellation checks. For live validation, use an isolated diagnostic workspace,
simulate the infrastructure failure, and let the actual research reviewer search/download a
benign licensed asset. Run real Blender source inspection on the downloaded GLB. Record live
acquisition separately from deterministic author/reviewer fixtures and final engine quality.

The new module changes pinned modeling tool hashes. Commit the release, use the repository Git
deployment script, and perform the authorized workspace plan/stage/apply/resume-check migration
before restarting an idle worker. Preserve historical pins, budgets, execution journals and
artifacts. Follow the repository autostart and task compatibility gates.
