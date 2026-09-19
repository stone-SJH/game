import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createController } from '../core/sandbox-controller.mjs';
import { readJson, sha256File } from '../core/common/fs.mjs';
import { compilePlan } from '../core/common/plan.mjs';
import { normalizeProgress } from '../api/tasks.mjs';

function fixture() {
  return {
    protocol: 1,
    objective: 'Build a test game iteration.',
    gameplay: { summary: 'Move, interact, succeed and restart.' },
    scene: { summary: 'One route, one landmark and one return path.' },
    visual: { summary: 'Readable grounded materials and no placeholder geometry.' },
    globalCriteria: [{ id: 'global-evidence', description: 'Accepted task evidence exists.' }],
  };
}

function tempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'yahaha3-')); }

test('sandbox owns the goal and host status mirrors the remote goal', async () => {
  const root = tempRoot();
  const request = { protocol: 1, hostTaskId: 'host-task-test', createdAt: new Date().toISOString(), input: fixture() };
  fs.mkdirSync(path.join(root, 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(root, 'inbox', `${request.hostTaskId}.json`), JSON.stringify(request));
  const controller = createController(root);
  await controller.tick();
  const status = readJson(path.join(root, 'public', 'tasks', `${request.hostTaskId}.json`));
  assert.equal(status.hostTaskId, request.hostTaskId);
  assert.equal(status.status, 'NEEDS_REPLAN');
  assert.equal(status.phase, 'core-design');
  assert.match(status.waitReason, /executor/i);
  const goals = fs.readdirSync(path.join(root, 'goals'));
  assert.equal(goals.length, 1);
  assert.equal(readJson(path.join(root, 'goals', goals[0], 'input.json')).objective, fixture().objective);
});

test('sandbox acceptance checks evidence hashes and completes without host review', async () => {
  const root = tempRoot();
  const request = { protocol: 1, hostTaskId: 'host-task-pass', createdAt: new Date().toISOString(), input: fixture() };
  fs.mkdirSync(path.join(root, 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(root, 'inbox', `${request.hostTaskId}.json`), JSON.stringify(request));
  const executor = async ({ taskDirectory, task }) => {
    const output = path.join(taskDirectory, 'output');
    fs.mkdirSync(output, { recursive: true });
    const file = path.join(output, 'report.json');
    fs.writeFileSync(file, JSON.stringify({ taskId: task.id, accepted: true }));
    fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify({
      protocol: 1,
      summary: 'Machine-checked evidence.',
      criteria: task.acceptanceCriteria.map(criterion => ({ id: criterion.id, status: 'PASS', evidence: [{ file: 'report.json', sha256: sha256File(file) }] })),
    }));
  };
  await createController(root, { executor }).tick();
  const status = readJson(path.join(root, 'public', 'tasks', `${request.hostTaskId}.json`));
  assert.equal(status.status, 'COMPLETED');
  assert.equal(status.globalDecision, 'PASS');
  assert.ok(Object.values(status.taskStatuses).every(value => value === 'ACCEPTED'));
});

test('invalid preflight input is reported to the host without creating a goal', async () => {
  const root = tempRoot();
  const request = { protocol: 1, hostTaskId: 'host-task-invalid', createdAt: new Date().toISOString(), input: { protocol: 1, objective: 'missing contracts' } };
  fs.mkdirSync(path.join(root, 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(root, 'inbox', `${request.hostTaskId}.json`), JSON.stringify(request));
  await createController(root).tick();
  const status = readJson(path.join(root, 'public', 'tasks', `${request.hostTaskId}.json`));
  assert.equal(status.status, 'INVALID_INPUT');
  assert.equal(fs.readdirSync(path.join(root, 'goals')).length, 0);
});

test('plan compilation rejects duplicate IDs and dependency cycles before creating a goal', async () => {
  const root = tempRoot();
  const request = { protocol: 1, hostTaskId: 'host-task-cycle', createdAt: new Date().toISOString(), input: {
    ...fixture(),
    tasks: [
      { id: 'a', objective: 'a', dependsOn: ['b'], acceptanceCriteria: [{ id: 'a-pass', description: 'a' }] },
      { id: 'b', objective: 'b', dependsOn: ['a'], acceptanceCriteria: [{ id: 'b-pass', description: 'b' }] },
    ],
  } };
  fs.mkdirSync(path.join(root, 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(root, 'inbox', `${request.hostTaskId}.json`), JSON.stringify(request));
  await createController(root).tick();
  const status = readJson(path.join(root, 'public', 'tasks', `${request.hostTaskId}.json`));
  assert.equal(status.status, 'INVALID_INPUT');
  assert.match(status.waitReason, /cycle/i);
});

test('compiled plans preserve task tool allocation and result contracts', () => {
  const plan = compilePlan({
    ...fixture(),
    context: { engine: { family: 'Unreal Engine 5' } },
    tasks: [{
      id: 'asset-audit', objective: 'Audit assets.', dependsOn: [], resource: 'assets:read',
      inputs: ['manifest.json'], outputs: ['audit.json'], tools: ['Assets4AI catalog'], evidence: ['audit.json'],
      resultContract: { required: ['selected', 'rejected'] }, retryPolicy: { maxAttempts: 2 },
      acceptanceCriteria: [{ id: 'audit-pass', description: 'The audit is complete.' }],
    }],
  });
  assert.equal(plan.plan.context.engine.family, 'Unreal Engine 5');
  assert.deepEqual(plan.plan.tasks[0].tools, ['Assets4AI catalog']);
  assert.deepEqual(plan.plan.tasks[0].resultContract.required, ['selected', 'rejected']);
  assert.equal(plan.plan.tasks[0].retryPolicy.maxAttempts, 2);
});

test('worker telemetry is normalized to bounded task progress', () => {
  const progress = normalizeProgress({ phase: 'CRAFTING', goal: '  Build the scene  ', tool: { name: 'Blender', command: 'blender.exe' },
    steps: { completed: 4, total: 7 }, prompt: '  use the current plan  ',
    diagnostic: { stage: 'unreal-project-validation-4', attempt: 4, message: 'No diagnostic output.', exitCode: 1, stderr: '  validation output  ' },
    screenshots: Array.from({ length: 5 }, (_, index) => ({ name: `screen-${index}.png` })),
    projectFiles: Array.from({ length: 6 }, (_, index) => ({ name: `file-${index}.umap` })),
    logFiles: Array.from({ length: 6 }, (_, index) => ({ name: `log-${index}.log` })) });
  assert.equal(progress.phase, 'crafting');
  assert.equal(progress.goal, 'Build the scene');
  assert.deepEqual(progress.steps, { completed: 4, total: 7 });
  assert.equal(progress.tool, 'Blender');
  assert.equal(progress.command, 'blender.exe');
  assert.equal(progress.error, 'No diagnostic output.');
  assert.deepEqual(progress.diagnostic, { stage: 'unreal-project-validation-4', category: 'unreal-validation', command: 'blender.exe', attempt: 4, message: 'No diagnostic output.', exitCode: 1, stderr: 'validation output', logFiles: ['unreal-project-validation-4.stdout.jsonl', 'unreal-project-validation-4.stderr.log'] });
  assert.equal(progress.projectFiles[0].name, 'file-0.umap');
  assert.equal(progress.screenshots.length, 2);
  assert.equal(progress.projectFiles.length, 4);
  assert.equal(progress.logFiles.length, 4);
  const workerText = normalizeProgress({ phase: 'failed', status: 'failed', step: 'Iteration 8: retry',
    error: '[workspace-cleanup] production-orchestrator-8 failed (exit 1):\nstderr:\nThe directory is not empty. (145)' });
  assert.equal(workerText.diagnostic.category, 'workspace-cleanup');
  assert.equal(workerText.diagnostic.stage, 'production-orchestrator-8');
  assert.equal(workerText.diagnostic.exitCode, 1);
  assert.match(workerText.diagnostic.stderr, /145/);
  const genericWorkerCategory = normalizeProgress({ phase: 'failed', status: 'failed', step: 'Iteration 8: retry',
    error: '[project-or-unknown] production-orchestrator-8 failed (exit 1): stale arg0 temporary directory cleanup failed, Windows error 145' });
  assert.equal(genericWorkerCategory.diagnostic.category, 'workspace-cleanup');
  const noOutput = normalizeProgress({ phase: 'failed', status: 'failed', step: 'Iteration 4: repair-project',
    error: 'unreal-project-validation-4 failed (exit 1):\nNo diagnostic output.' });
  assert.equal(noOutput.diagnostic.category, 'missing-output');
  assert.equal(noOutput.diagnostic.noOutput, true);
  assert.equal(normalizeProgress(null), null);
  assert.equal(normalizeProgress({ tool: null, prompt: null }).tool, null);
});
