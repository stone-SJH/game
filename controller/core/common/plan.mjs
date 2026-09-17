import { id, sha256Json } from './fs.mjs';

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function criteria(entries, label) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error(`${label} must contain criteria`);
  const seen = new Set();
  return entries.map(entry => {
    const criterionId = id(entry.id, `${label}.id`);
    if (seen.has(criterionId)) throw new Error(`Duplicate ${label} criterion: ${criterionId}`);
    seen.add(criterionId);
    return { id: criterionId, description: text(entry.description, `${label}.${criterionId}.description`) };
  });
}

function textList(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => text(entry, `${label}[${index}]`));
}

function objectValue(value, label, fallback = {}) {
  if (value === undefined) return fallback;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function defaultTasks(input) {
  return [
    {
      id: 'core-design',
      objective: 'Freeze the core gameplay loop, player verbs, failure/restart rules and success condition.',
      dependsOn: [],
      resource: 'planning',
      acceptanceCriteria: [{ id: 'core-design-recorded', description: 'The gameplay contract is recorded as a structured artifact.' }],
    },
    {
      id: 'scene-layout',
      objective: 'Freeze scene zones, traversal envelope, camera framing and greybox layout.',
      dependsOn: ['core-design'],
      resource: 'project:scene',
      acceptanceCriteria: [{ id: 'scene-layout-recorded', description: 'The scene contract and greybox evidence are recorded.' }],
    },
    {
      id: 'visual-quality',
      objective: 'Establish the visual style, quality bar and representative view requirements.',
      dependsOn: ['scene-layout'],
      resource: 'project:scene',
      acceptanceCriteria: [{ id: 'visual-quality-recorded', description: 'The visual contract and quality gates are recorded.' }],
    },
    {
      id: 'game-production',
      objective: text(input.productionObjective || 'Produce the playable game iteration within the approved contracts.', 'productionObjective'),
      dependsOn: ['core-design', 'scene-layout', 'visual-quality'],
      resource: 'project:scene',
      acceptanceCriteria: criteria(input.productionCriteria || [{ id: 'production-evidence', description: 'The playable iteration has complete evidence.' }], 'productionCriteria'),
    },
    {
      id: 'final-validation',
      objective: 'Run the sandbox-owned validation suite and decide whether the global objective is complete.',
      dependsOn: ['game-production'],
      resource: 'project:scene',
      acceptanceCriteria: criteria(input.validationCriteria || [{ id: 'validation-evidence', description: 'All final quality gates have machine-readable evidence.' }], 'validationCriteria'),
    },
  ];
}

export function normalizeInput(input) {
  if (!input || input.protocol !== 1) throw new Error('Input protocol 1 is required');
  const objective = text(input.objective, 'objective');
  const gameplay = text(input.gameplay?.summary, 'gameplay.summary');
  const scene = text(input.scene?.summary, 'scene.summary');
  const visual = text(input.visual?.summary, 'visual.summary');
  const globalCriteria = criteria(input.globalCriteria, 'globalCriteria');
  const outputs = Array.isArray(input.outputs) && input.outputs.length ? input.outputs.map(output => text(output, 'outputs[]')) : ['playable-build', 'quality-report', 'evidence-manifest'];
  const tasks = input.tasks ? input.tasks.map(task => ({
    id: id(task.id, 'task.id'), objective: text(task.objective, 'task.objective'), dependsOn: [...new Set(task.dependsOn || [])],
    resource: text(task.resource || 'project:scene', 'task.resource'),
    resources: textList(task.resources, `task.${task.id}.resources`),
    parallelGroup: task.parallelGroup === undefined ? null : text(task.parallelGroup, `task.${task.id}.parallelGroup`),
    inputs: textList(task.inputs, `task.${task.id}.inputs`),
    outputs: textList(task.outputs, `task.${task.id}.outputs`),
    tools: textList(task.tools, `task.${task.id}.tools`),
    evidence: textList(task.evidence, `task.${task.id}.evidence`),
    resultContract: objectValue(task.resultContract, `task.${task.id}.resultContract`),
    retryPolicy: objectValue(task.retryPolicy, `task.${task.id}.retryPolicy`),
    acceptanceCriteria: criteria(task.acceptanceCriteria, `task.${task.id}.acceptanceCriteria`),
  })) : defaultTasks(input);
  const taskIds = new Set(tasks.map(task => task.id));
  if (taskIds.size !== tasks.length) throw new Error('Task IDs must be unique');
  for (const task of tasks) for (const dependency of task.dependsOn) if (!taskIds.has(dependency) || dependency === task.id) throw new Error(`Invalid dependency for ${task.id}: ${dependency}`);
  const visiting = new Set();
  const visited = new Set();
  const visit = taskId => {
    if (visiting.has(taskId)) throw new Error(`Task dependency cycle at ${taskId}`);
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependency of tasks.find(task => task.id === taskId).dependsOn) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of tasks) visit(task.id);
  const context = input.context && typeof input.context === 'object' && !Array.isArray(input.context) ? input.context : {};
  return { protocol: 1, objective, gameplay: { summary: gameplay }, scene: { summary: scene }, visual: { summary: visual }, context, globalCriteria, outputs, tasks };
}

export function compilePlan(input) {
  const normalized = normalizeInput(input);
  const plan = { protocol: 1, objective: normalized.objective, gameplay: normalized.gameplay, scene: normalized.scene, visual: normalized.visual, context: normalized.context, globalCriteria: normalized.globalCriteria, outputs: normalized.outputs, tasks: normalized.tasks };
  return { input: normalized, plan, revision: sha256Json(plan) };
}
