import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagnoseUpstreamAI, isAiInvocation, upstreamAiEvent } from '../agent/modeling-upstream-ai.mjs';
import { normalizeProgress } from '../../controller/api/tasks.mjs';

const stage = 'quality-review-4';
const httpMessage = 'unexpected status 503 Service Unavailable: Service temporarily unavailable, url: http://43.106.115.130:8080/v1/responses, request id: request-test-503';
const event = message => ({ type: 'turn.failed', error: { message } });
const failed = (...events) => ({ result: { exitCode: 1, stopConfirmed: true,
  stdout: events.map(value => JSON.stringify(value)).join('\n'), stderr: 'WARNING: stale arg0 temp dirs: error 145' } });

test('upstream cause survives current controller normalization with service and request identity', () => {
  const diagnostic = diagnoseUpstreamAI(failed(event(httpMessage)), { stage });
  assert.equal(diagnostic.code, 'HTTP_503');
  assert.equal(diagnostic.httpStatus, 503);
  assert.equal(diagnostic.endpoint, 'http://43.106.115.130:8080/v1/responses');
  assert.equal(diagnostic.requestId, 'request-test-503');
  const progress = normalizeProgress({ step: stage, error: diagnostic.message, diagnostic });
  assert.equal(progress.diagnostic.category, 'upstream-ai');
  assert.equal(progress.diagnostic.stage, stage);
  assert.match(progress.error, /上游 AI 服务调用失败.*HTTP 503 Service Unavailable/);
  assert.match(progress.error, /quality-review-4.*43\.106\.115\.130:8080\/v1\/responses.*request-test-503/);
  assert.doesNotMatch(progress.error, /arg0|145/);
  assert.ok(progress.error.length < 1000);
});

test('transport causes include HTTP errors, disconnected streams, timeouts and network failures', () => {
  for (const [message, code] of [
    ['HTTP 401 Unauthorized', 'HTTP_401'], ['HTTP 403 Forbidden', 'HTTP_403'],
    ['unexpected status 429 Too Many Requests', 'HTTP_429'], ['HTTP 500 Internal Server Error', 'HTTP_500'],
    ['HTTP/1.1 502 Bad Gateway', 'HTTP_502'], ['status code: 504 Gateway Timeout', 'HTTP_504'],
    ['stream disconnected before completion: stream closed before response.completed', 'STREAM_DISCONNECTED'],
    ['ECONNRESET', 'CONNECTION_RESET'], ['request timed out', 'REQUEST_TIMEOUT'],
    ['connect ETIMEDOUT', 'REQUEST_TIMEOUT'], ['EAI_AGAIN', 'DNS_ERROR'], ['ENOTFOUND', 'DNS_ERROR'],
    ['connect ECONNREFUSED', 'CONNECTION_REFUSED'], ['error sending request for url (https://api.example.test/v1/responses)', 'REQUEST_SEND_FAILED'],
  ]) assert.equal(diagnoseUpstreamAI(failed(event(message)), { stage }).code, code, message);
  const retry = upstreamAiEvent({ type: 'error', message: 'Reconnecting... 2/5 (stream disconnected before completion)' }, stage);
  assert.deepEqual(retry.retry, { attempt: 2, limit: 5 });
  assert.match(retry.message, /响应流中断.*正在重连（2\/5）/);
  assert.equal(retry.httpStatus, undefined);
  assert.equal(retry.endpoint, undefined); // Never invent an endpoint absent from the error.
});

test('public diagnostics omit secrets and arbitrary URL paths', () => {
  for (const endpoint of ['https://alice:secret@api.example.test/v1/responses?token=hidden#private',
    'https://api.example.test/secret-tenant/v1/responses?api_key=hidden']) {
    const diagnostic = upstreamAiEvent(event('HTTP 503 Service Unavailable, url: ' + endpoint), stage);
    assert.match(diagnostic.message, /https:\/\/api.example.test/);
    assert.doesNotMatch(JSON.stringify(diagnostic), /alice|secret|hidden|private|api_key/);
  }
});

test('unrelated tools, prose and local errors are not misreported as upstream AI failure', () => {
  const quoted = { type: 'item.completed', item: { type: 'agent_message', text: httpMessage } };
  const tool = { type: 'item.completed', item: { type: 'command_execution', aggregated_output: httpMessage } };
  for (const value of [quoted, tool]) {
    assert.equal(upstreamAiEvent(value, stage), null);
    assert.equal(diagnoseUpstreamAI(failed(value), { stage }), null);
  }
  assert.equal(diagnoseUpstreamAI(failed(event(httpMessage)), { stage: 'package-publication' }), null);
  assert.equal(diagnoseUpstreamAI(failed(event(httpMessage)), { stage: 'unreal-project-validation-1' }), null);
  for (const override of [{ timedOut: true }, { canceled: true }, { stopConfirmed: false }, { error: 'spawn node ENOENT' }]) {
    const error = failed(event(httpMessage)); Object.assign(error.result, override);
    assert.equal(diagnoseUpstreamAI(error, { stage }), null);
  }
  assert.equal(diagnoseUpstreamAI({ message: 'Invalid quality reviewer JSON.' }, { stage }), null);
  assert.equal(diagnoseUpstreamAI({ message: 'Quality review must cover every original criterion exactly once.' }, { stage }), null);
  assert.equal(diagnoseUpstreamAI({ result: { exitCode: 1, stdout: '',
    stderr: 'source line: HTTP 503 Service Unavailable\nSyntaxError: Invalid or unexpected token' } }, { stage }), null);
  assert.equal(diagnoseUpstreamAI({ result: { exitCode: 1, stdout: '',
    stderr: "error: unexpected argument 'HTTP 503 Service Unavailable' found" } }, { stage }), null);
});

test('final event takes priority over reconnect history and completed turns clear failures', () => {
  const retry = { type: 'error', message: 'Reconnecting... 1/5 (' + httpMessage + ')' };
  assert.equal(diagnoseUpstreamAI(failed(retry, event('stream disconnected before completion')), { stage }).code, 'STREAM_DISCONNECTED');
  assert.equal(diagnoseUpstreamAI(failed(retry, { type: 'turn.completed' }), { stage }), null);
  assert.equal(diagnoseUpstreamAI(failed(retry, event('Invalid local output schema')), { stage }), null);
  const plain = diagnoseUpstreamAI({ message: 'quality-review failed', result: { exitCode: 1, stderr: httpMessage } }, { stage });
  assert.equal(plain.code, 'HTTP_503');
});

test('AI invocation detection includes modeling reviewers while excluding Blender validators', () => {
  for (const name of ['production-orchestrator-2','quality-review-4','iteration-diagnosis-2']) assert.equal(isAiInvocation(name), true);
  assert.equal(isAiInvocation('modeling-engineering-review-2', ['cli.mjs','exec','--json']), true);
  assert.equal(isAiInvocation('modeling-technical-2', ['-b','--python','check.py']), false);
});
