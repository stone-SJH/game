import { hashValue, readJson } from './modeling-io.mjs';

export async function rejectedImageDetails({ spec, inputIdentity, responseEvidence, requestStateFile, evidence = [] }) {
  let submitted;
  const files = [...new Set([requestStateFile, ...evidence.slice().reverse().map(row => row.file)].filter(Boolean))];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const value = await readJson(file);
    if (typeof value?.prompt === 'string' && value.prompt.length <= 32000 &&
        (value.requestHash || value.constraintsChecked === true)) { submitted = value; break; }
  }
  return { provider: 'concept-image', inputIdentity, prompt: submitted?.prompt || null,
    promptHash: submitted?.prompt ? hashValue(submitted.prompt) : null, requestHash: submitted?.requestHash || null,
    referenceImages: spec.generationInput?.referenceImages || spec.referenceImages,
    response: responseEvidence, exactTriggerKnown: false };
}

// User-facing diagnostics are separate from generation input and bounded agent handoffs.
export function generationInputFeedback(modeling, { iteration, revisionId, runId } = {}) {
  const blockedAssets = (modeling?.assets || []).flatMap(asset => {
    const issues = (asset.quality?.gaps || []).filter(issue => issue.requiresInputChange);
    return issues.length ? [{ assetId: asset.assetId, issues: issues.map(issue => ({ kind: issue.kind,
      stage: issue.stage, reason: issue.reason, input: issue.inputReview || null, response: issue.responseEvidence || issue.inputReview?.response || null })) }] : [];
  });
  if (!blockedAssets.length) return null;
  const identifiers = blockedAssets.map(asset => asset.assetId + ': ' + asset.issues.map(issue => {
    const response = issue.response || {};
    return [issue.input?.provider, response.code || response.providerCode || issue.kind,
      response.requestId ? 'request ' + response.requestId : null].filter(Boolean).join(' / ');
  }).join('; '));
  return { protocol: 1, kind: 'generation-input-required', status: 'NEEDS_INPUT_REVISION', iteration, revisionId, runId,
    action: 'revise-input', productionIncomplete: true, blockedAssets,
    reason: 'Generation input needs revision (' + identifiers.join('; ') + '). Unchanged input will not be submitted again. In Continue, specify the asset and a complete revised visual description; see the attached generation-input report for the actual request.',
    providerCause: 'A content-review code does not identify the exact triggering word, image region or legal reason. Do not infer copyright or another specific cause without provider evidence.',
    nextActions: [
      'Give the affected asset a complete revised visual description and identify the earlier appearance requirements it replaces. Keep the technical contract and unaffected assets.',
      'Remove unintended history or workflow text; use only intended references. If the subject matter is rejected, change it to acceptable content. The revised request remains subject to provider review.',
      'If a different design or reference is acceptable, specify that scope change explicitly. Do not silently substitute a different asset or route rejected content through another provider.',
      'A plain Continue, changed metadata or repeated polling cannot clear this rejection. A changed effective prompt/reference input receives a new record; old requests, failures and budgets remain intact.',
    ],
    continueTemplate: 'For asset(s) ' + blockedAssets.map(row => row.assetId).join(', ') + ', replace the previous generation brief with: [complete revised appearance]. Supersede these conflicting visual requirements: [list]. Use these generation references: [files or none]. Preserve all technical contracts and other assets. Generate, integrate and verify the revised asset; report any new refusal with its actual input and request ID.' };
}
