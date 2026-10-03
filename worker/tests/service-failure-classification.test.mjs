import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failureKind } from '../agent/service-recovery.mjs';
import { commandDiagnostic } from '../agent/production-harness.mjs';

const quoted = 'ENOSPC disk full invalid_api_key authentication failed model_not_found unsupported model HTTP 503 ECONNRESET';
function failed(message, type = 'command_execution') {
  const result = { exitCode: 1, stopConfirmed: true, stderr: '', stdout: [
    { type: 'item.completed', item: { id: 'read', type, exit_code: 0, status: 'completed', text: quoted, aggregated_output: quoted } },
    { type: 'turn.failed', error: { message } },
  ].map(JSON.stringify).join('\n') };
  return Object.assign(new Error(`production-orchestrator-6 failed:\n${commandDiagnostic(result)}`), { result });
}

test('terminal failures determine classification instead of quoted tool/model content and wrapper diagnostics', () => {
  for (const type of ['command_execution', 'agent_message', 'mcp_tool_call']) {
    for (const [message, expected] of [
      ['HTTP 503 Service Unavailable', 'SERVICE_TRANSIENT'],
      ['HTTP 401 authentication failed', 'SERVICE_CONFIGURATION'],
      ['ENOSPC: no space left on device', 'RESOURCE_EXHAUSTED'],
      ['Invalid local output schema', 'CONTENT_GAP'],
    ]) assert.equal(failureKind(failed(message, type)), expected);
  }
});

test('structured upstream failures take precedence over prose, while local resource and shutdown failures still stop', () => {
  const error = failed('HTTP 503 Service Unavailable');
  error.upstreamAI = { category: 'upstream-ai', code: 'HTTP_503', httpStatus: 503 };
  assert.equal(failureKind(error), 'SERVICE_TRANSIENT');
  for (const code of ['ENOSPC', 'EDQUOT', 'EROFS', 'EIO']) assert.equal(failureKind({ ...error, code }), 'RESOURCE_EXHAUSTED');
  assert.equal(failureKind({ ...error, result: { ...error.result, error: 'ENOSPC: writing command log' } }), 'RESOURCE_EXHAUSTED');
  assert.equal(failureKind({ ...error, stopConfirmed: false }), 'STOP_UNCONFIRMED');
  assert.equal(failureKind({ ...error, kind: 'RESOURCE_EXHAUSTED' }), 'RESOURCE_EXHAUSTED');
  assert.equal(failureKind({ ...error, status: 401 }), 'SERVICE_CONFIGURATION');
});

test('completed turns clear reconnect history and ordinary command failures retain their diagnostics', () => {
  const error = failed('HTTP 503 Service Unavailable');
  error.result.stdout += '\n' + JSON.stringify({ type: 'turn.completed' });
  assert.equal(failureKind(error), 'CONTENT_GAP');
  for (const [message, expected] of [['ENOSPC', 'RESOURCE_EXHAUSTED'], ['authentication failed', 'SERVICE_CONFIGURATION'], ['HTTP 503', 'SERVICE_TRANSIENT']]) {
    assert.equal(failureKind(new Error(message)), expected);
    assert.equal(failureKind({ result: { stdout: message } }), expected);
    assert.equal(failureKind({ result: { stderr: message } }), expected);
  }
});
