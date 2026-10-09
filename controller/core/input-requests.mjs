import { digest, problem } from '../api/database.mjs';

export const decisionHash = value => digest(JSON.stringify(canonical(value)));
function canonical(value) {
  return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
const requireText = (value, max = 4000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const hash = value => /^[a-f0-9]{64}$/.test(value || '');
const relative = value => requireText(value, 500) && !/^[\\/]|[\x00-\x1f:]/.test(value) && !value.split(/[\\/]/).includes('..');
const kinds = new Set(['contract-conflict', 'visual-revision', 'generation-input-rejected', 'scope-choice']);

export function validateInputRequest(request) {
  const fail = reason => { throw problem(400, 'Invalid input request: ' + reason); };
  if (!request || JSON.stringify(request).length > 96000) fail('missing or oversized record');
  if (request.protocol !== 1 || !/^question-[a-f0-9]{64}$/.test(request.requestId || '') || !kinds.has(request.kind)) fail('protocol or identity');
  for (const key of ['taskId', 'revisionId', 'runId']) if (!/^[a-zA-Z0-9-]{1,100}$/.test(request[key] || '')) fail(key);
  if (!hash(request.basePlanHash) || !hash(request.effectiveInputHash)) fail('dependency hashes');
  for (const [key, max] of [['title', 300], ['reason', 6000], ['stage', 100], ['expected', 6000], ['actual', 6000]]) {
    if (!requireText(request[key], max)) fail(key);
  }
  if (!Array.isArray(request.assetIds) || request.assetIds.length > 20 || request.assetIds.some(id => !/^[a-zA-Z0-9_-]{1,160}$/.test(id))) fail('assets');
  if (!Array.isArray(request.evidence) || !request.evidence.length || request.evidence.length > 20 ||
      request.evidence.some(row => !row || !relative(row.path) || !hash(row.sha256))) fail('evidence');
  if (!Array.isArray(request.options) || request.options.length < 2 || request.options.length > 3 || request.options.some(row => !row) || new Set(request.options.map(row => row.id)).size !== request.options.length) fail('options');
  for (const option of request.options) {
    if (!/^[a-z0-9-]{1,60}$/.test(option.id) || !requireText(option.label, 160) || !requireText(option.consequences, 1500) ||
        !requireText(option.instruction, 6000) || typeof option.requiresText !== 'boolean') fail('option contents');
  }
  if (request.generationInput != null) {
    const input = request.generationInput;
    if (input.prompt !== null && !requireText(input.prompt, 32000)) fail('actual generation prompt');
    for (const key of ['provider', 'code', 'requestId']) if (input[key] !== null && !requireText(input[key], 300)) fail('provider evidence');
    if (!Array.isArray(input.referenceImages) || input.referenceImages.length > 4 || input.referenceImages.some(row => !row || !relative(row.path) || !hash(row.sha256))) fail('generation references');
    if (input.submittedImage != null && (!relative(input.submittedImage.path) || !hash(input.submittedImage.sha256))) fail('actual submitted image');
  }
  return request;
}

export function validateDecisionAnswer(request, input) {
  if (!/^[a-zA-Z0-9-]{8,100}$/.test(input?.idempotencyKey || '')) throw problem(400, 'An answer idempotency key is required.');
  if (input.requestId !== request.requestId || input.revisionId !== request.revisionId || input.basePlanHash !== request.basePlanHash ||
      input.effectiveInputHash !== request.effectiveInputHash) throw problem(409, 'This question has changed. Refresh the task and answer the current question.');
  const option = input.optionId ? request.options.find(row => row.id === input.optionId) : null;
  if (input.optionId && !option) throw problem(400, 'Select one of the displayed options.');
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (text.length > 6000 || (!option || option.requiresText) && text.length < 12 || /^(continue|go on|yes|ok|继续|同意|可以)[.!。！\s]*$/iu.test(text)) {
    throw problem(422, 'Give a complete revised description or select a concrete amendment. Plain Continue is not a revised input.');
  }
  const referencePaths = input.referencePaths ?? request.generationInput?.referenceImages.map(row => row.path) ?? [];
  if (!Array.isArray(referencePaths) || new Set(referencePaths).size !== referencePaths.length ||
      referencePaths.some(file => !request.generationInput?.referenceImages.some(row => row.path === file))) throw problem(400, 'Choose only the displayed generation references.');
  if (request.kind === 'generation-input-rejected' && text === request.generationInput?.prompt &&
      decisionHash(referencePaths.slice().sort()) === decisionHash(request.generationInput.referenceImages.map(row => row.path).sort())) {
    throw problem(422, 'The actual rejected prompt and references are unchanged. Revise their content before submitting.');
  }
  if (typeof input.grantNewBudget !== 'boolean') throw problem(400, 'An explicit budget choice is required.');
  const instruction = [
    `Answer to ${request.kind} for assets ${request.assetIds.join(', ') || '(project)'}.`,
    option ? 'Selected amendment: ' + option.instruction : '',
    text ? 'User answer / complete revised visual description: ' + text : '',
    request.generationInput ? 'Use only these generation reference paths: ' + JSON.stringify(referencePaths) + '. Other references remain comparison evidence.' : '',
    'Apply only this explicitly authorized change. Preserve unrelated obligations, provenance, historical artifacts and consumed budgets; rerun affected acceptance checks.',
  ].filter(Boolean).join('\n');
  return { optionId: option?.id || null, text, referencePaths, grantNewBudget: input.grantNewBudget, instruction };
}
