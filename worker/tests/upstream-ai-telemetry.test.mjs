import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { executeJob } from '../agent/agent.mjs';
import { normalizeProgress } from '../../controller/api/tasks.mjs';

test('live CLI errors reach frontend progress, preserve raw logs and clear on recovery or a new step', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'upstream-telemetry-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = path.join(root, 'fake-ai.mjs');
  await fs.writeFile(script, [
    "const mode = process.argv.at(-1);",
    "const streamError = 'stream disconnected before completion: stream closed before response.completed';",
    "const send = value => process.stdout.write(JSON.stringify(value) + '\\n');",
    "if (mode === 'unrelated') send({type:'error',message:'HTTP 503 from artifact service'});",
    "else {",
    "  send({type:'error',message:'Reconnecting... 1/5 (' + streamError + ')'});",
    "  await new Promise(resolve => setTimeout(resolve, 60));",
    "  if (mode === 'recover') send({type:'turn.completed'});",
    "  else {send({type:'turn.failed',error:{message:streamError}}); process.exitCode = 1;}",
    "}",
  ].join('\n'));
  const progress = [];
  const job = { taskId: 'task', workspaceId: 'workspace', runId: 'run', objective: 'Fixture' };
  await executeJob(job, { root, signal: new AbortController().signal,
    serviceRecoveryOptions: { maxWaitMs: 0 },
    reportProgress: async value => progress.push(normalizeProgress(value)),
    productionHarness: async ({ step }) => {
      await step('modeling-engineering-review-1', process.execPath, [script, 'exec', 'recover'], 10000);
      await assert.rejects(step('quality-review-1', process.execPath, [script, 'exec', 'fail'], 10000), error => {
        assert.equal(error.upstreamAI.code, 'STREAM_DISCONNECTED');
        assert.match(error.result.stdout, /stream disconnected/); return true;
      });
      await step('packaged-game-playtest-1', process.execPath, [script, 'unrelated'], 10000);
      return { files: {}, qualityAccepted: false, delivery: { iteration: 1, score: 0, threshold: 85, playable: false } };
    } });
  const recovered = progress.filter(value => value.step === 'modeling-engineering-review-1');
  assert.ok(recovered.some(value => /正在重连（1\/5）/.test(value.error)));
  assert.equal(recovered.at(-1).error, null); assert.equal(recovered.at(-1).diagnostic, null);
  const failed = progress.filter(value => value.step === 'quality-review-1');
  assert.ok(failed.some(value => value.diagnostic?.category === 'upstream-ai'));
  assert.match(failed.at(-1).error, /上游 AI 服务调用失败.*响应流中断/);
  assert.equal(failed.at(-1).diagnostic.exitCode, 1);
  assert.deepEqual(failed.at(-1).diagnostic.logFiles, ['quality-review-1.stdout.jsonl','quality-review-1.stderr.log']);
  const following = progress.filter(value => value.step === 'packaged-game-playtest-1');
  assert.ok(following.length); assert.ok(following.every(value => !value.error && !value.diagnostic));
  const output = path.join(root, 'workspaces/workspace/runs/run');
  const raw = await fs.readFile(path.join(output, 'quality-review-1.stdout.jsonl'), 'utf8');
  assert.match(raw, /turn.failed/); assert.match(raw, /stream disconnected/);
});

test('terminal task failures keep the classified cause in progress and the control result', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'upstream-terminal-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = path.join(root, 'fake-ai.mjs');
  const message = 'unexpected status 503 Service Unavailable, url: http://43.106.115.130:8080/v1/responses';
  await fs.writeFile(script, `console.log(JSON.stringify({type:'turn.failed',error:{message:${JSON.stringify(message)}}})); process.exitCode = 1;`);
  const progress = [];
  const result = await executeJob({ taskId: 'task', workspaceId: 'workspace', runId: 'run', objective: 'Fixture' }, {
    root, signal: new AbortController().signal, reportProgress: async value => progress.push(normalizeProgress(value)),
    serviceRecoveryOptions: { maxWaitMs: 0 },
    productionHarness: async ({ step }) => { await step('production-orchestrator-1', process.execPath, [script], 10000); },
  });
  assert.equal(result.status, 'FAIL');
  assert.match(result.reason, /上游 AI 服务调用失败.*HTTP 503/);
  assert.equal(result.report.failure, result.reason);
  assert.equal(progress.at(-1).error, result.reason);
  assert.equal(progress.at(-1).diagnostic.category, 'upstream-ai');
  const report = JSON.parse(await fs.readFile(path.join(root, 'workspaces/workspace/runs/run/production-report.json'), 'utf8'));
  assert.match(report.logs[0].stdout, /unexpected status 503 Service Unavailable/);
});
