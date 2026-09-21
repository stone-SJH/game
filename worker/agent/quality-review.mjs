import { monitorInvocationArgs } from './iteration-monitor.mjs';

const MAX_QUALITY_ITERATIONS = 5;
const QUALITY_MARKER = /(?:quality\s+(?:acceptance\s+)?criteria|quality\s+requirements|quality\s+standards|质量验收条件|质量标准|质量要求)\s*[:：]/i;
const DIMENSIONS = ['artPrecision', 'levelPacing', 'interactionFeel'];
const STATUS = ['PASS', 'GAP', 'NOT_APPLICABLE'];

const dimensionSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    status: { type: 'string', enum: STATUS },
    summary: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    gap: { type: 'string' },
  },
  required: ['status', 'summary', 'evidence', 'gap'],
};

export const qualityAdviceSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['complete', 'repair-project'] },
    reason: { type: 'string' },
    criteria: {
      type: 'array', minItems: 1,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string' },
          description: { type: 'string' },
          status: { type: 'string', enum: STATUS },
          evidence: { type: 'array', items: { type: 'string' } },
          gap: { type: 'string' },
        },
        required: ['id', 'description', 'status', 'evidence', 'gap'],
      },
    },
    dimensions: {
      type: 'object', additionalProperties: false,
      properties: Object.fromEntries(DIMENSIONS.map(name => [name, dimensionSchema])),
      required: DIMENSIONS,
    },
    repairInstructions: { type: 'string' },
    remainingGap: { type: 'number', minimum: 0, maximum: 1 },
    recommendedAdditionalIterations: { type: 'integer', minimum: 0, maximum: MAX_QUALITY_ITERATIONS },
  },
  required: ['action', 'reason', 'criteria', 'dimensions', 'repairInstructions', 'remainingGap', 'recommendedAdditionalIterations'],
};

function clean(value, max = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function criterionList(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => {
      const description = typeof item === 'string' ? item : item && typeof item === 'object'
        ? item.description || item.text || item.name : '';
      const text = clean(description, 1200);
      return text ? [{ id: clean(item?.id, 120) || `quality-${index + 1}`, description: text }] : [];
    });
  }
  if (typeof value !== 'string') return [];
  return value.split(/\r?\n|[;；]+/).flatMap((line, index) => {
    const description = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();
    return description ? [{ id: `quality-${index + 1}`, description: clean(description, 1200) }] : [];
  });
}

export function extractQualityCriteria(job = {}) {
  const payload = job.payload && typeof job.payload === 'object' ? job.payload : {};
  for (const value of [job.qualityCriteria, payload.qualityCriteria, payload.qualityAcceptanceCriteria, payload.qualityRequirements]) {
    const criteria = criterionList(value);
    if (criteria.length) return criteria;
  }
  const objective = String(job.objective || '');
  const marker = objective.match(QUALITY_MARKER);
  if (!marker) return [];
  const section = objective.slice(marker.index + marker[0].length).split(/\n\s*\n/)[0];
  return criterionList(section);
}

function integerSetting(name, fallback, max, min = 0) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}

export function qualityReviewSettings() {
  return {
    maxIterations: integerSetting('QUALITY_REVIEW_MAX_ITERATIONS', MAX_QUALITY_ITERATIONS, MAX_QUALITY_ITERATIONS),
    timeoutMs: integerSetting('QUALITY_REVIEW_TIMEOUT_MS', 60000, 60000, 1000),
  };
}

export function qualityReviewInvocationArgs(invocation, project, schemaFile, responseFile) {
  return monitorInvocationArgs(invocation, project, schemaFile, responseFile);
}

export function qualityReviewPrompt({ job, project, criteria, attempt, evidence = null, previous = null }) {
  return [
    'You are the independent quality acceptance reviewer for a game-production iteration.',
    'The hard production gates already passed. Use only the supplied machine-readable task evidence; do not edit files, run commands, start agents, or invent requirements.',
    'Evaluate the explicit quality acceptance criteria below and report evidence relative to the workspace.',
    'Always assess these dimensions: art precision (visual fidelity, asset integration, composition), level pacing (route rhythm, difficulty ramp, rest and challenge spacing), and interaction feel (input response, camera/control feedback, recovery and affordance). Mark a dimension NOT_APPLICABLE only when the objective truly does not cover it.',
    'A PASS requires concrete evidence. If evidence is missing or insufficient for an explicit criterion or applicable dimension, treat that as a GAP and request the smallest repair that can produce evidence. If all explicit criteria and applicable dimensions pass, choose complete.',
    'Do not request changes for personal taste, unmentioned features, or improvements unsupported by the objective. Do not weaken or rewrite hard acceptance gates.',
    `Workspace: ${project}`,
    `Task objective: ${job.objective}`,
    `Explicit quality criteria: ${JSON.stringify(criteria)}`,
    `Machine-readable quality evidence: ${JSON.stringify(evidence || {})}`,
    `Production iteration: ${attempt}`,
    ...(previous ? [`Previous quality review: ${JSON.stringify(previous)}`] : []),
    'Return only the requested JSON schema.',
  ].join('\n');
}

export function parseQualityAdvice(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('Invalid quality reviewer JSON.'); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Invalid quality reviewer response.');
  const keys = Object.keys(qualityAdviceSchema.properties);
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('Quality reviewer returned unknown fields.');
  if (!['complete', 'repair-project'].includes(value.action) || !clean(value.reason) || !Array.isArray(value.criteria) || !value.criteria.length ||
      !value.dimensions || typeof value.dimensions !== 'object' || typeof value.repairInstructions !== 'string' ||
      !Number.isFinite(value.remainingGap) || value.remainingGap < 0 || value.remainingGap > 1 ||
      !Number.isSafeInteger(value.recommendedAdditionalIterations) || value.recommendedAdditionalIterations < 0 || value.recommendedAdditionalIterations > MAX_QUALITY_ITERATIONS) {
    throw new Error('Invalid quality reviewer response.');
  }
  const criteria = value.criteria.map((item, index) => {
    if (!item || typeof item !== 'object' || !clean(item.id, 120) || !clean(item.description, 1200) || !STATUS.includes(item.status) ||
        !Array.isArray(item.evidence) || item.evidence.some(entry => typeof entry !== 'string') || typeof item.gap !== 'string') throw new Error(`Invalid quality criterion at index ${index}.`);
    return { id: clean(item.id, 120), description: clean(item.description, 1200), status: item.status,
      evidence: item.evidence.map(entry => clean(entry, 400)).filter(Boolean).slice(0, 12), gap: clean(item.gap, 1200) };
  });
  const dimensions = {};
  for (const name of DIMENSIONS) {
    const item = value.dimensions[name];
    if (!item || typeof item !== 'object' || !STATUS.includes(item.status) || !clean(item.summary, 1200) || !Array.isArray(item.evidence) ||
        item.evidence.some(entry => typeof entry !== 'string') || typeof item.gap !== 'string') throw new Error(`Invalid quality dimension: ${name}.`);
    dimensions[name] = { status: item.status, summary: clean(item.summary, 1200), evidence: item.evidence.map(entry => clean(entry, 400)).filter(Boolean).slice(0, 12), gap: clean(item.gap, 1200) };
  }
  const gaps = criteria.some(item => item.status === 'GAP') || Object.values(dimensions).some(item => item.status === 'GAP');
  if (value.action === 'repair-project' && (!gaps || !clean(value.repairInstructions, 4000) || value.remainingGap <= 0 || value.recommendedAdditionalIterations < 1)) {
    throw new Error('Quality reviewer requested repair without a concrete remaining gap.');
  }
  if (value.action === 'complete' && (gaps || value.remainingGap !== 0)) throw new Error('Quality reviewer completed with an unresolved gap.');
  return { action: value.action, reason: clean(value.reason), criteria, dimensions,
    repairInstructions: clean(value.repairInstructions, 4000), remainingGap: value.remainingGap,
    recommendedAdditionalIterations: value.recommendedAdditionalIterations };
}
