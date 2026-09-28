import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, hashFile, hashValue, localPath, readJson } from './modeling-io.mjs';
import { createExecutionStore, verifyEvidence } from './modeling-execution.mjs';
import { validateSkillPlan } from './modeling-skill-routing.mjs';

const allowed = new Set(['agent/modeling-pipeline.mjs', 'agent/modeling-skill-routing.mjs', 'agent/modeling-blockout-evidence.mjs']);

function checkHarnessChange(before, after) {
  const left = new Map(before.map(row => [row.file, row.sha256]));
  const right = new Map(after.map(row => [row.file, row.sha256]));
  const changed = [...new Set([...left.keys(), ...right.keys()])].filter(file => left.get(file) !== right.get(file));
  if (!changed.length || changed.some(file => !allowed.has(file)) || [...left.keys()].some(file => !right.has(file))) {
    throw new Error('Migration permits only the reviewed blockout backup and continuation changes.');
  }
  return changed;
}

async function jsonFiles(root) {
  const files = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = await localPath(root, entry.name, { existing: true });
    if (entry.isDirectory()) files.push(...await jsonFiles(file));
    else if (entry.name.endsWith('.json')) files.push(file);
  }
  return files;
}

export async function planBlockoutMigration({ workspace, taskId, beforeHarness, afterHarness, runtime, policy, targetCommit }) {
  if (!/^[a-f0-9]{40}$/.test(targetCommit)) throw new Error('A committed target release is required.');
  const changed = checkHarnessChange(beforeHarness, afterHarness);
  const project = path.join(workspace, 'project');
  const context = await readJson(path.join(project, 'plan/production-context.json'));
  if (context?.taskId !== taskId || !context.workspaceId) throw new Error('Task identity does not match this workspace.');
  const stateRoot = path.join(workspace, 'modeling-state');
  const taskRoot = path.join(stateRoot, 'tasks', hashValue({ taskId, workspaceId: context.workspaceId }));
  await createExecutionStore(taskRoot).assertSettled();
  const runtimeFile = path.join(taskRoot, 'execution-policy/toolchain-runtime.json');
  const priorRuntime = await readJson(runtimeFile);
  if (hashValue(priorRuntime?.runtime) !== hashValue(runtime) || hashValue(priorRuntime?.policy) !== hashValue(policy)) {
    throw new Error('Runtime settings or execution policy changed; this migration cannot repin them.');
  }
  const pins = [runtimeFile, ...(await fs.readdir(taskRoot)).filter(name => /^toolchain-.*\.json$/.test(name)).map(name => path.join(taskRoot, name))];
  const updates = [];
  for (const file of pins) {
    const before = await fs.readFile(file, 'utf8'), value = JSON.parse(before);
    if (hashValue(value.harnessHashes) !== hashValue(beforeHarness)) throw new Error(`Unexpected pinned release: ${file}`);
    if (value.skillLockHash) {
      const skillPlan = await readJson(await localPath(project, `tools/modeling-skills/${value.skillLockHash}/skill-plan.json`));
      if (!skillPlan || hashValue(skillPlan.resources) !== value.skillLockHash) throw new Error('Archived skill identity is invalid.');
      await validateSkillPlan(project, skillPlan);
    }
    updates.push({ file, before, sha256: await hashFile(file) });
  }
  // Verify the state that will be reused; failed attempts remain historical records.
  for (const entry of await fs.readdir(stateRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'tasks') continue;
    const state = await readJson(path.join(stateRoot, entry.name, 'state.json'));
    if (!state) continue;
    for (const candidate of [state.accepted, state.bestCandidate]) {
      await verifyEvidence(await Promise.all((candidate?.files || []).map(async row => ({
        file: await localPath(project, row.path), sha256: row.sha256 }))));
    }
    for (const rows of [state.pending?.blockout?.evidence, state.pending?.artifactEvidence, state.pending?.technical?.evidence]) await verifyEvidence(rows);
  }
  const files = [...await jsonFiles(stateRoot), ...await jsonFiles(path.join(workspace, 'production-state'))];
  const preserve = [];
  for (const file of files.filter(file => !pins.includes(file))) preserve.push({ file, sha256: await hashFile(file) });
  return { protocol: 1, kind: 'blockout-backup-migration', taskId, workspaceId: context.workspaceId,
    workspace: path.resolve(workspace), targetCommit, beforeHarness, afterHarness, changed,
    updates, preserve, preparedAt: new Date().toISOString() };
}

// Caller must hold worker maintenance: no agent/journal, no controller allocation.
// The durable audit is written before any pin. Interrupted applies are idempotent.
export async function applyBlockoutMigration(plan, auditFile, currentHarness) {
  if (plan.protocol !== 1 || plan.kind !== 'blockout-backup-migration' ||
      hashValue(currentHarness) !== hashValue(plan.afterHarness)) throw new Error('Migration target code changed.');
  checkHarnessChange(plan.beforeHarness, plan.afterHarness);
  const taskRoot = path.join(plan.workspace, 'modeling-state/tasks', hashValue({ taskId: plan.taskId, workspaceId: plan.workspaceId }));
  const changes = [];
  for (const row of plan.updates) {
    const relative = path.relative(taskRoot, row.file).replaceAll('\\', '/');
    if (!/^(?:execution-policy\/toolchain-runtime|toolchain-[a-zA-Z0-9_-]+)\.json$/.test(relative)) throw new Error('Migration path is not a task toolchain pin.');
    await localPath(taskRoot, relative, { existing: true });
    const before = JSON.parse(row.before);
    if (hashValue(before.harnessHashes) !== hashValue(plan.beforeHarness)) throw new Error('Migration source identity changed.');
    const after = { ...before, harnessHashes: plan.afterHarness };
    const current = await readJson(row.file);
    const prior = hashValue(current) === hashValue(before), applied = hashValue(current) === hashValue(after);
    if (!prior && !applied) throw new Error('Task pin changed after migration preflight.');
    if (prior && await hashFile(row.file) !== row.sha256) throw new Error('Task pin bytes changed after preflight.');
    changes.push({ ...row, after, applied });
  }
  await createExecutionStore(taskRoot).assertSettled();
  await verifyEvidence(plan.preserve);
  const planHash = hashValue(plan), existing = await readJson(auditFile);
  if (existing && existing.planHash !== planHash) throw new Error('Migration audit belongs to another plan.');
  const audit = existing || { protocol: 1, planHash, status: 'PREPARED', plan, startedAt: new Date().toISOString() };
  await atomicJson(auditFile, audit);
  for (const row of changes) if (!row.applied) await atomicJson(row.file, row.after);
  await verifyEvidence(plan.preserve);
  audit.status = 'APPLIED'; audit.finishedAt = new Date().toISOString();
  audit.updatedPins = await Promise.all(changes.map(async row => ({ file: row.file, beforeSha256: row.sha256, afterSha256: await hashFile(row.file) })));
  await atomicJson(auditFile, audit);
  return audit;
}
