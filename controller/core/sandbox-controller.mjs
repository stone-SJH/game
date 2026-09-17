import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateGlobal, evaluateTask } from './common/acceptance.mjs';
import { atomicJson, optionalJson, readJson, timestamp } from './common/fs.mjs';
import { appendEvent, goalPaths, listInbox, newGoalId, paths, writeStatus } from './common/control-store.mjs';
import { compilePlan } from './common/plan.mjs';

function taskStatuses(plan, state) { return Object.fromEntries(plan.tasks.map(task => [task.id, state.tasks[task.id].status])); }

export function createController(root, { executor = null, now = () => Date.now() } = {}) {
  const store = paths(root);

  function persist(goal, state, plan, hostTaskId, event) {
    state.updatedAt = timestamp(now());
    state.taskStatuses = taskStatuses(plan, state);
    atomicJson(goal.state, state);
    if (event) appendEvent(goal, event, now());
    writeStatus(store, hostTaskId, state);
  }

  function createGoal(request) {
    const compiled = compilePlan(request.input);
    const goalId = newGoalId(now());
    const goal = goalPaths(store, goalId);
    atomicJson(goal.input, compiled.input);
    atomicJson(goal.plan, { ...compiled.plan, revision: compiled.revision });
    const state = { protocol: 1, goalId, hostTaskId: request.hostTaskId, revision: compiled.revision, status: 'RUNNING', phase: 'core-design', tasks: Object.fromEntries(compiled.plan.tasks.map(task => [task.id, { status: 'PLANNED', attempts: 0, criteria: [] }])), taskStatuses: {}, globalDecision: null, createdAt: timestamp(now()), updatedAt: timestamp(now()) };
    persist(goal, state, compiled.plan, request.hostTaskId, { type: 'GOAL_CREATED', goalId, revision: compiled.revision });
    return { goal, state, plan: compiled.plan };
  }

  async function runTask(goal, state, plan, task) {
    const taskState = state.tasks[task.id];
    const taskDirectory = path.join(goal.tasks, task.id);
    fs.mkdirSync(taskDirectory, { recursive: true });
    taskState.status = 'RUNNING';
    taskState.attempts += 1;
    state.phase = task.id;
    persist(goal, state, plan, state.hostTaskId, { type: 'TASK_STARTED', taskId: task.id, attempt: taskState.attempts });
    if (!executor) {
      taskState.status = 'HOLD';
      state.waitReason = 'No sandbox executor configured; no acceptance inferred.';
      persist(goal, state, plan, state.hostTaskId, { type: 'TASK_HELD', taskId: task.id, reason: state.waitReason });
      return;
    }
    await executor({ goal, state, plan, task, taskDirectory });
    const decision = evaluateTask(task, taskDirectory);
    taskState.criteria = decision.criteria;
    taskState.reason = decision.reason;
    taskState.status = decision.decision === 'PASS' ? 'ACCEPTED' : decision.decision;
    state.waitReason = decision.decision === 'PASS' ? null : decision.reason;
    persist(goal, state, plan, state.hostTaskId, { type: 'TASK_REVIEWED', taskId: task.id, decision: decision.decision, reason: decision.reason });
  }

  async function advance(goal, state, plan) {
    for (const task of plan.tasks) {
      const taskState = state.tasks[task.id];
      if (taskState.status !== 'PLANNED' || !task.dependsOn.every(id => state.tasks[id].status === 'ACCEPTED')) continue;
      await runTask(goal, state, plan, task);
      if (state.tasks[task.id].status !== 'ACCEPTED') {
        state.status = 'NEEDS_REPLAN';
        persist(goal, state, plan, state.hostTaskId, { type: 'GOAL_WAITING', reason: state.waitReason });
        return state;
      }
    }
    const accepted = plan.tasks.map(task => ({ taskId: task.id, ...state.tasks[task.id] }));
    const global = evaluateGlobal(plan, accepted.filter(task => task.status === 'ACCEPTED'));
    state.globalDecision = global.decision;
    state.status = global.decision === 'PASS' ? 'COMPLETED' : 'NEEDS_REPLAN';
    state.phase = 'global-review';
    state.waitReason = global.reason;
    persist(goal, state, plan, state.hostTaskId, { type: 'GLOBAL_REVIEWED', decision: global.decision, reason: global.reason });
    return state;
  }

  async function processRequest(file) {
    const request = readJson(file);
    const created = createGoal(request);
    await advance(created.goal, created.state, created.plan);
    fs.rmSync(file, { force: true });
    return created.state;
  }

  async function tick() {
    for (const file of listInbox(store)) {
      try { await processRequest(file); } catch (error) {
        const request = optionalJson(file);
        if (request?.hostTaskId) atomicJson(path.join(store.publicTasks, `${request.hostTaskId}.json`), { protocol: 1, hostTaskId: request.hostTaskId, status: 'INVALID_INPUT', waitReason: error.message, updatedAt: timestamp(now()) });
        fs.rmSync(file, { force: true });
      }
    }
  }

  return { tick, processRequest, store };
}

const rootArg = process.argv.find(arg => arg.startsWith('--root='));
const root = path.resolve(rootArg ? rootArg.slice('--root='.length) : 'control');
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--once')) await createController(root).tick();
  else { const controller = createController(root); while (true) { await controller.tick(); await new Promise(resolve => setTimeout(resolve, 1000)); } }
}
