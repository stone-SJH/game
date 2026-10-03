import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicJson, hashFile, hashValue } from '../agent/modeling-io.mjs';
import { createExecutionStore, fileEvidence, failureRecord } from '../agent/modeling-execution.mjs';
import { retainedFinalForValidation } from '../agent/modeling-author-recovery.mjs';
import { failureKind } from '../agent/service-recovery.mjs';

async function fixture(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'retained-final-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const project = path.join(workspace, 'project'), stateRoot = path.join(workspace, 'state');
  const requirementsHash = 'a'.repeat(64), attemptId = `roof-${requirementsHash.slice(0, 20)}-blender_direct-3`;
  const directory = `art/models/roof/${requirementsHash.slice(0, 20)}/blender_direct-3`;
  await fs.mkdir(path.join(project, directory), { recursive: true });
  for (const name of ['source.blend', 'model.glb', 'model.fbx', 'recipe.py', 'asset-manifest.json', 'build-report.json'])
    await fs.writeFile(path.join(project, directory, name), name.endsWith('.json') ? '{}' : name);
  const scriptFile = `${directory}/recipe.py`, scriptHash = await hashFile(path.join(project, scriptFile));
  const calls = [{ tool: 'blender_run_python', scriptFile, scriptHash, exitCode: 0, stopConfirmed: true }];
  const receiptFile = path.join(workspace, 'run/mcp.json');
  await atomicJson(receiptFile, { calls });
  await atomicJson(receiptFile + '.blockout.json', { calls });
  const frozenFile = `${directory}/blockout/preview.png`;
  await fs.mkdir(path.dirname(path.join(project, frozenFile)), { recursive: true });
  await fs.writeFile(path.join(project, frozenFile), 'frozen');
  await atomicJson(path.join(stateRoot, `blockout-evidence/${hashValue(attemptId)}/manifest.json`), {
    protocol: 2, attemptId, rows: [{ path: frozenFile, sha256: await hashFile(path.join(project, frozenFile)) }] });
  const failed = { kind: 'SERVICE_TRANSIENT', timedOut: true, canceled: false, stopConfirmed: true };
  const groups = {
    blockout: { key: `author:${attemptId}-blockout`, completed: true, calls: [{ status: 'COMPLETED' }],
      result: { receiptFile: receiptFile + '.blockout.json', evidence: await fileEvidence([receiptFile + '.blockout.json']) } },
    final: { key: `author:${attemptId}-final`, calls: [{ callId: 'author-9', status: 'FAILED', error: failed }], terminalError: failed },
  };
  const ledger = { protocol: 3, nextCall: 10, groups };
  const execution = createExecutionStore(stateRoot);
  await atomicJson(execution.file, ledger);
  const state = { spec: { assetId: 'roof', contract: { runtime: { profile: 'fbx-static' } } }, requirementsHash,
    route: 'blender_direct', attempts: { blender_direct: 3 }, revisionBudgets: { r: { attempts: { blender_direct: 3 } } },
    attemptBudgets: { [attemptId]: { startedAt: 1, deadlineAt: 2 } }, pending: null,
    failures: [{ ...failed, attemptId, phase: 'FINAL_PENDING' }] };
  return { workspace, project, stateRoot, state, execution, ledger, attemptId, directory, receiptFile, calls, frozenFile };
}

test('expired final exports enter only host validation without changing failed calls or consumed budgets', async t => {
  const f = await fixture(t), before = structuredClone(f.state), hash = await hashFile(f.execution.file);
  const pending = await retainedFinalForValidation(f);
  assert.equal(pending.phase, 'TECHNICAL_PENDING'); assert.equal(pending.attempt, 3);
  assert.equal(pending.recovery.callId, 'author-9'); assert.ok(pending.artifactEvidence.length >= 9);
  assert.deepEqual(f.state, before); assert.equal(await hashFile(f.execution.file), hash);
  assert.equal(pending.technical, undefined); assert.equal(pending.accepted, undefined);
  f.state.finalAuthorRecoveries = { [f.attemptId]: pending.recovery };
  assert.equal(await retainedFinalForValidation(f), null);
});

test('canceled, unconfirmed and non-final calls cannot be recovered', async t => {
  const f = await fixture(t);
  for (const patch of [{ canceled: true }, { stopConfirmed: false }, { timedOut: false }, { phase: 'AUTHORING' },
    { kind: 'RESOURCE_EXHAUSTED' }, { kind: 'SERVICE_CONFIGURATION' }, { kind: 'INTEGRITY_ERROR' }]) {
    const state = structuredClone(f.state); Object.assign(state.failures[0], patch);
    assert.equal(await retainedFinalForValidation({ ...f, state }), null);
  }
  f.ledger.groups.final.calls[0].status = 'STARTED'; await atomicJson(f.execution.file, f.ledger);
  await assert.rejects(retainedFinalForValidation(f), error => error.kind === 'STOP_UNCONFIRMED');
});

test('partial exports and failed last Blender writes are not complete retained finals', async t => {
  const f = await fixture(t);
  f.calls[0].exitCode = 1; await atomicJson(f.receiptFile, { calls: f.calls });
  assert.equal(await retainedFinalForValidation(f), null);
  f.calls[0].exitCode = 0; await atomicJson(f.receiptFile, { calls: f.calls });
  await fs.unlink(path.join(f.project, f.directory, 'model.fbx'));
  assert.equal(await retainedFinalForValidation(f), null);
});

test('modified frozen evidence and uncertain Blender processes retain their fences', async t => {
  const f = await fixture(t);
  f.calls[0].stopConfirmed = false; await atomicJson(f.receiptFile, { calls: f.calls });
  await assert.rejects(retainedFinalForValidation(f), error => error.kind === 'STOP_UNCONFIRMED');
  f.calls[0].stopConfirmed = true; await atomicJson(f.receiptFile, { calls: f.calls });
  await fs.appendFile(path.join(f.project, f.frozenFile), 'changed');
  await assert.rejects(retainedFinalForValidation(f), error => error.kind === 'INTEGRITY_ERROR');
});

test('recovery never reopens an existing host validation budget', async t => {
  const f = await fixture(t);
  f.ledger.groups.technical = { key: `technical:${f.attemptId}`, calls: [{ status: 'FAILED', error: { stopConfirmed: true } }] };
  await atomicJson(f.execution.file, f.ledger);
  assert.equal(await retainedFinalForValidation(f), null);
});

test('host deadlines stay author timeouts despite quoted service errors or a stale classification', () => {
  const error = { kind: 'SERVICE_TRANSIENT', result: { timedOut: true, stopConfirmed: true, exitCode: 1,
    stderr: 'upstream error from optional cleanup', stdout: JSON.stringify({ type: 'turn.failed', error: { message: 'HTTP 503' } }) } };
  assert.equal(failureKind(error), 'CONTENT_GAP');
  assert.equal(failureRecord(error, 'AUTHOR').kind, 'AUTHOR_TIMEOUT');
  assert.equal(failureRecord({ ...error, code: 'ENOSPC' }, 'AUTHOR').kind, 'RESOURCE_EXHAUSTED');
  assert.equal(failureRecord({ ...error, stopConfirmed: false }, 'AUTHOR').kind, 'STOP_UNCONFIRMED');
  assert.equal(failureRecord(error, 'AUTHOR', { aborted: true }).kind, 'CANCELED');
});
