import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicJson, readJson, hashFile, hashValue } from '../agent/modeling-io.mjs';
import { readModelingState } from '../agent/modeling-state.mjs';
import { planPendingSettlement, applyPendingSettlement, verifyRetainedModelingSkills } from '../agent/modeling-maintenance.mjs';
import { createSkillPlan } from '../agent/modeling-skill-routing.mjs';
import { defaultContract } from '../agent/modeling-contract.mjs';

async function fixture(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'settle-pending-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const job = { taskId: 'task', workspaceId: path.basename(workspace) };
  await atomicJson(path.join(workspace, 'project/plan/production-context.json'), job);
  const file = path.join(workspace, 'modeling-state', 'a'.repeat(20), 'state.json');
  const state = { protocol: 2, spec: { assetId: 'rock' }, attempts: { image_tripo_blender: 2 },
    rounds: { 12: { attempts: { image_tripo_blender: 2 } } }, revisionBudgets: { revision: { attempts: { image_tripo_blender: 2 } } },
    attemptBudgets: { 'rock-2': { startedAt: 1, deadlineAt: 100 } },
    pending: { attemptId: 'rock-2', phase: 'AUTHORING', route: 'image_tripo_blender' }, failures: [{ kind: 'SERVICE_TRANSIENT' }] };
  const execution = path.join(workspace, 'modeling-state/tasks', hashValue(job), 'execution.json');
  await atomicJson(execution, { protocol: 2, nextCall: 9, groups: { group: { key: 'author:rock-2-blockout', stage: 'AUTHOR',
    calls: [{ callId: 'author-8', startedAt: 1, status: 'FAILED', error: { kind: 'SERVICE_TRANSIENT', stopConfirmed: true } }] } } });
  await atomicJson(file, state);
  return { workspace, file, state, execution };
}

test('offline settlement archives a stopped failure and preserves budgets and execution bytes, including crash recovery', async t => {
  const f = await fixture(t), before = await hashFile(f.execution), plan = await planPendingSettlement(f.workspace);
  assert.equal(plan.repairs.length, 1); assert.deepEqual(await readModelingState(f.file), f.state);
  const result = await applyPendingSettlement(f.workspace, plan), after = await readModelingState(f.file);
  assert.equal(result.settled, 1); assert.equal(after.pending, null);
  for (const key of ['attempts', 'rounds', 'revisionBudgets', 'attemptBudgets', 'failures']) assert.deepEqual(after[key], f.state[key]);
  assert.deepEqual(after.maintenanceSettlements[0].pending, f.state.pending); assert.equal(await hashFile(f.execution), before);
  assert.deepEqual(await applyPendingSettlement(f.workspace, plan), result);
  await fs.unlink(path.join(f.workspace, 'recovery', `settled-pending-${plan.planHash}`, 'receipt.json'));
  assert.deepEqual(await applyPendingSettlement(f.workspace, plan), result);
});

test('unconfirmed, live and changed execution evidence cannot be settled', async t => {
  const f = await fixture(t), ledger = await readJson(f.execution);
  const plan = await planPendingSettlement(f.workspace);
  ledger.groups.group.calls[0].error.stopConfirmed = false; await atomicJson(f.execution, ledger);
  await assert.rejects(planPendingSettlement(f.workspace), /verify its process tree/);
  await assert.rejects(applyPendingSettlement(f.workspace, plan), /evidence changed/);
  ledger.groups.group.calls[0].error.stopConfirmed = true; ledger.groups.group.calls[0].status = 'STARTED'; await atomicJson(f.execution, ledger);
  await assert.rejects(planPendingSettlement(f.workspace), /verify its process tree/);
  assert.deepEqual(await readModelingState(f.file), f.state);
});

test('resume verification uses recovered reference inputs without rewriting skills or starting a round', async t => {
  const f = await fixture(t), project = path.join(f.workspace, 'project');
  const job = await readJson(path.join(project, 'plan/production-context.json'));
  const taskRoot = path.dirname(f.execution);
  const base = { assetId: 'rock', referenceImages: [], contract: defaultContract() };
  const enriched = { ...base, referenceImages: ['reference.png'] }, plan = { assets: [base] };
  const image = path.join(project, 'reference.png'); await fs.writeFile(image, 'retained reference pixels');
  const skills = await createSkillPlan({ spec: enriched, project });
  await atomicJson(path.join(taskRoot, 'toolchain-rock.json'), { skillLockHash: skills.lockHash });
  await atomicJson(f.file, { ...f.state, requirementsHash: 'frozen', spec: enriched });
  await atomicJson(path.join(taskRoot, 'recovery.json'), { protocol: 1, taskId: job.taskId, workspaceId: job.workspaceId,
    productionIdentity: 'b'.repeat(64), planHash: hashValue(plan), iteration: 1,
    assets: [{ assetId: 'rock', baseHash: hashValue(base), statePath: path.relative(f.workspace, f.file),
      requirementsHash: 'frozen', specHash: hashValue(enriched), referenceEvidence: [{ file: image, sha256: await hashFile(image) }] }] });
  const files = [f.file, f.execution, path.join(project, 'tools/modeling-skills', skills.lockHash, 'skill-plan.json')];
  const before = await Promise.all(files.map(hashFile));
  await assert.rejects(createSkillPlan({ spec: base, project, pinnedLockHash: skills.lockHash }), { kind: 'INTEGRITY_ERROR' });
  assert.deepEqual(await verifyRetainedModelingSkills({ workspace: f.workspace, job, plan }), ['rock']);
  assert.deepEqual(await Promise.all(files.map(hashFile)), before);
  await fs.appendFile(image, 'changed');
  await assert.rejects(verifyRetainedModelingSkills({ workspace: f.workspace, job, plan }), { kind: 'INTEGRITY_ERROR' });
});
