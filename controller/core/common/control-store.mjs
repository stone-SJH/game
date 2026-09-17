import fs from 'node:fs';
import path from 'node:path';
import { appendJsonLine, atomicJson, ensureDir, newId, optionalJson, timestamp } from './fs.mjs';

export function paths(root) {
  return {
    root,
    inbox: ensureDir(path.join(root, 'inbox')),
    goals: ensureDir(path.join(root, 'goals')),
    publicTasks: ensureDir(path.join(root, 'public', 'tasks')),
  };
}

export function goalPaths(store, goalId) {
  const directory = ensureDir(path.join(store.goals, goalId));
  return { directory, state: path.join(directory, 'state.json'), plan: path.join(directory, 'plan.json'), input: path.join(directory, 'input.json'), events: path.join(directory, 'events.jsonl'), tasks: ensureDir(path.join(directory, 'tasks')) };
}

export function appendEvent(goal, event, now = Date.now()) {
  appendJsonLine(goal.events, { sequence: (optionalJson(`${goal.events}.sequence`)?.value || 0) + 1, at: timestamp(now), ...event });
  atomicJson(`${goal.events}.sequence`, { value: (optionalJson(`${goal.events}.sequence`)?.value || 0) + 1 });
}

export function writeStatus(store, hostTaskId, state) {
  atomicJson(path.join(store.publicTasks, `${hostTaskId}.json`), { protocol: 1, hostTaskId, goalId: state.goalId, status: state.status, phase: state.phase, updatedAt: state.updatedAt, taskStatuses: state.taskStatuses, waitReason: state.waitReason || null, globalDecision: state.globalDecision || null });
}

export function newGoalId(now = Date.now()) { return newId('goal', now); }

export function listInbox(store) {
  return fs.readdirSync(store.inbox).filter(name => name.endsWith('.json')).sort().map(name => path.join(store.inbox, name));
}
