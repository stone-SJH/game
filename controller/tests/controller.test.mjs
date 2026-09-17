import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createController } from '../core/sandbox-controller.mjs';
import { readJson, sha256File } from '../core/common/fs.mjs';
import { compilePlan } from '../core/common/plan.mjs';

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
