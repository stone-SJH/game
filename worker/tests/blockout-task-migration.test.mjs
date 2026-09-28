import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { atomicJson, hashFile, hashValue, readJson } from '../agent/modeling-io.mjs';
import { createExecutionStore } from '../agent/modeling-execution.mjs';
import { createSkillPlan } from '../agent/modeling-skill-routing.mjs';
import { defaultContract } from '../agent/modeling-contract.mjs';
import { planBlockoutMigration, applyBlockoutMigration } from '../agent/blockout-task-migration.mjs';

async function fixture(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'blockout-migration-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const project = path.join(workspace, 'project'), taskId = 'task', workspaceId = 'workspace';
  await atomicJson(path.join(project, 'plan/production-context.json'), { taskId, workspaceId });
  const taskRoot = path.join(workspace, 'modeling-state/tasks', hashValue({ taskId, workspaceId }));
  const beforeHarness = [{ file: 'agent/modeling-pipeline.mjs', sha256: 'a'.repeat(64) }];
  const afterHarness = [{ file: 'agent/modeling-pipeline.mjs', sha256: 'b'.repeat(64) }, { file: 'agent/modeling-blockout-evidence.mjs', sha256: 'c'.repeat(64) }];
  const policy = { buildMs: 10000, reviewCalls: 4 }, runtime = { configuredModel: 'fixture' };
  const runtimeFile = path.join(taskRoot, 'execution-policy/toolchain-runtime.json');
  await atomicJson(runtimeFile, { policy, runtime, harnessHashes: beforeHarness });
  await atomicJson(path.join(taskRoot, 'toolchain-asset.json'), { version: 3, policy, validatorHashes: ['unchanged'], harnessHashes: beforeHarness });
  await atomicJson(path.join(workspace, 'production-state/round/iterations.json'), { attempts: 4, iteration: 2 });
  await createExecutionStore(taskRoot).run({ key: 'author:final', stage: 'AUTHOR', timeoutMs: 10000 }, async () => ({ completed: 'original result' }));
  const args = { workspace, taskId, beforeHarness, afterHarness, policy, runtime, targetCommit: 'd'.repeat(40) };
  return { ...args, args, taskRoot, runtimeFile, audit: path.join(workspace, 'audit.json') };
}

test('migration changes only harness pins, keeps all budgets and completed calls, and is idempotent', async t => {
  const f = await fixture(t), plan = await planBlockoutMigration(f.args);
  const preserved = await Promise.all(plan.preserve.map(async row => [row.file, await hashFile(row.file)]));
  const audit = await applyBlockoutMigration(plan, f.audit, f.afterHarness);
  assert.equal(audit.status, 'APPLIED');
  assert.equal(audit.updatedPins.length, 2);
  assert.deepEqual((await readJson(f.runtimeFile)).policy, f.policy);
  assert.deepEqual((await readJson(f.runtimeFile)).runtime, f.runtime);
  assert.deepEqual((await readJson(f.runtimeFile)).harnessHashes, f.afterHarness);
  for (const [file, hash] of preserved) assert.equal(await hashFile(file), hash);
  let calls = 0;
  const result = await createExecutionStore(f.taskRoot).run({ key: 'author:final', stage: 'AUTHOR', timeoutMs: 10000 }, () => calls++);
  assert.deepEqual(result, { completed: 'original result' }); assert.equal(calls, 0);
  assert.equal((await applyBlockoutMigration(plan, f.audit, f.afterHarness)).status, 'APPLIED');
});

test('changed policies, unrelated code, active calls and changed evidence block migration', async t => {
  const f = await fixture(t);
  await assert.rejects(planBlockoutMigration({ ...f.args, policy: { ...f.policy, reviewCalls: 100 } }), /policy changed/);
  await assert.rejects(planBlockoutMigration({ ...f.args, afterHarness: [...f.afterHarness, { file: 'agent/modeling-execution.mjs', sha256: 'e'.repeat(64) }] }), /reviewed blockout/);
  const plan = await planBlockoutMigration(f.args), before = await hashFile(f.runtimeFile);
  await fs.appendFile(plan.preserve[0].file, '\n');
  await assert.rejects(applyBlockoutMigration(plan, f.audit, f.afterHarness), /evidence changed/);
  assert.equal(await hashFile(f.runtimeFile), before);
  await assert.rejects(createExecutionStore(f.taskRoot).run({ key: 'orphan', stage: 'AUTHOR', timeoutMs: 1000,
    onReserved: () => { throw new Error('crash'); } }, () => {}), /crash/);
  await assert.rejects(planBlockoutMigration(f.args), error => error.kind === 'STOP_UNCONFIRMED');
});

test('archived skills retain their original lock even when installed instructions change', async t => {
  const f = await fixture(t), skillsRoot = path.join(f.workspace, 'skills');
  await atomicJson(path.join(skillsRoot, 'modeling-upstream-lock.json'), { files: [{ localPath: 'unselected/resource', sha256: 'a'.repeat(64) }] });
  await fs.mkdir(path.join(skillsRoot, 'yahaha-blender-modeling'));
  await fs.writeFile(path.join(skillsRoot, 'yahaha-blender-modeling/SKILL.md'), 'Original instructions');
  const spec = { referenceImages: [], contract: defaultContract() };
  const before = await createSkillPlan({ project: path.join(f.workspace, 'project'), spec, skillsRoot });
  await fs.writeFile(path.join(skillsRoot, 'yahaha-blender-modeling/SKILL.md'), 'New instructions');
  const resumed = await createSkillPlan({ project: path.join(f.workspace, 'project'), spec, skillsRoot, pinnedLockHash: before.lockHash });
  assert.deepEqual(resumed, before);
  await fs.appendFile(path.join(f.workspace, 'project', before.entrypoints[0]), 'tampered');
  await assert.rejects(createSkillPlan({ project: path.join(f.workspace, 'project'), spec, skillsRoot, pinnedLockHash: before.lockHash }), /evidence changed/);
});
