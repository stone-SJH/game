# Upstream AI failure diagnostics

AI invocation errors are published through the existing `progress.error` and
`progress.diagnostic` fields. The current controller and frontend already display
these fields; no controller or frontend deployment is required for this change.

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
existing handling. A recovered turn or a new step clears the current upstream
error; recorded failure events remain available in iteration history.

Quality-review failures retain the classified cause in the delivered iteration,
including the terminal iteration-budget path. Terminal task failures also preserve
the classified message. Retry budgets, acceptance gates, task state transitions and
evidence retention are unchanged. A transport/status diagnostic identifies the
observed failure; it does not infer the server's internal cause of a 503.

## Verification and rollout

Run `node --test worker/tests/*.test.mjs` on Windows. The focused suites are
`upstream-ai-diagnostics`, `upstream-ai-telemetry`, `quality-review` and
`iteration-monitor`. Tests exercise real subprocess output and the existing
controller normalization without invoking an AI provider.

The fix takes effect after an authorized worker deployment. Existing persisted
history is not rewritten. Do not restart active work to activate diagnostics. The
new `modeling-upstream-ai.mjs` participates in the modeling toolchain fingerprint;
preserve pinned task compatibility through the established, verified deployment
and migration procedure before resuming a pinned task on a new release.
