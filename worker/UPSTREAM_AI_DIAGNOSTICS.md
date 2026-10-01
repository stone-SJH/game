# Upstream AI failure diagnostics

Terminal AI invocation errors are published through the existing `progress.error`
and `progress.diagnostic` fields. Transient reconnects use `waiting_service`,
`status: running` and `waitReason`, with no failure diagnostic. The current
controller and frontend already support these fields.

Examples:

- `上游 AI 服务调用失败：HTTP 503 Service Unavailable（服务暂不可用）。阶段：quality-review-4。服务：http://43.106.115.130:8080/v1/responses。`
- `上游 AI 服务调用失败：响应流中断（stream disconnected），未收到完整 AI 响应。`

The diagnostic includes the actual stage, a sanitized endpoint and request ID when
the CLI supplies them. HTTP status, stream disconnection, connection reset/refusal,
request timeout and DNS failures remain distinguishable. Reconnect events include
their reported attempt count. Credentials, URL queries and arbitrary URL paths are
excluded from the public diagnostic; the original command logs remain unchanged.

Only AI invocation failures and CLI error events are classified. Tool output and
model prose quoting an error are not evidence of an upstream failure. Cancellation,
worker timeouts, execution fences and local process startup failures retain their
existing handling. Tool/model activity after a reconnect, a recovered turn or a
new step clears the current upstream wait. Raw CLI events remain in command logs.

## Recovery after tool activity

Worker-owned JSON/stdin Codex calls persist their session instead of using
`--ephemeral`. After a transient transport or HTTP 408/429/5xx failure, the worker
backs off and resumes the exact recorded session ID. It keeps the original CLI
configuration, output paths, tool results and saved workspace, and instructs the
agent to continue unfinished work. It never selects a session using `--last`.
This uses the supported [Codex exec resume command](https://learn.chatgpt.com/docs/non-interactive-mode#resume-a-non-interactive-session).

Service retries stay inside one author/production invocation and use the existing
durable service budget (15 minutes of waiting by default), bounded by the original
step and task deadlines. Each subprocess gets only the remaining time. Failed
attempt logs retain their original names; subsequent logs have `-service-N`
suffixes. Blender MCP receipts append across server restarts so recipe validation
can still inspect earlier successful operations.

A missing session after tool activity, an unfinished tool, an unconfirmed child
shutdown, cancellation, timeout or configuration failure does not permit replay.
Persistent service failure can still exhaust the recorded wait/deadline budget;
that is a terminal failure with retained outputs, not a new content attempt.

The 2026-09-30 incident on task `task-0c7aa7f2-966d-4612-8bb7-0f5f8e78e302`
showed both paths: `final-author-919` recovered from stream disconnects and exited
successfully; `final-author-924` later exhausted the CLI's HTTP 429 retries. Its
completed tool activity made the old worker set `retrySafe: false`, so no worker
service retry ran (`serviceAttempt: 1`). Exact-session continuation removes this
blanket prohibition without replaying the author prompt.

Quality-review failures retain the classified cause in the delivered iteration,
including the terminal iteration-budget path. Terminal task failures also preserve
the classified message. Acceptance gates and task state transitions are unchanged.
A transport/status diagnostic identifies the
observed failure; it does not infer the server's internal cause of a 503.

## Verification and rollout

Concept-image generation also uses durable service recovery. Received HTTP 408/429/500/502/503/504
responses back off within the same concept operation, honoring Retry-After and the original
deadline. HTTP rejections and wait budgets survive restarts without consuming another quality
round. Other HTTP 4xx responses are configuration failures, not asset-quality gaps. A timeout,
lost response, invalid successful response or interrupted submission has unknown provider
completion status and remains fenced from duplicate paid submission. Full response bodies and
credentials are never copied into the recovery log. The previous image request/evidence stays
available when recovery cannot continue.

Run `node --test worker/tests/*.test.mjs` on Windows. The focused suites are
`upstream-ai-diagnostics`, `upstream-ai-telemetry`, `upstream-ai-recovery`,
`modeling-v2`, `quality-review` and `iteration-monitor`. Tests exercise real subprocess output and the existing
controller normalization without invoking an AI provider.

The fix takes effect after an authorized worker deployment. Existing persisted
history is not rewritten. Do not restart active work to activate diagnostics. The
new `modeling-upstream-ai.mjs` participates in the modeling toolchain fingerprint;
preserve pinned task compatibility through the established, verified deployment
and migration procedure before resuming a pinned task on a new release.
