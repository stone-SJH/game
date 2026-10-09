import { hashValue } from './modeling-io.mjs';

const text = { type: 'string', minLength: 1, maxLength: 3000 };
export const generationInputSchema = {
  type: 'object', additionalProperties: false,
  required: ['prompt', 'requirements', 'referenceImages', 'excludedTerms'],
  properties: {
    prompt: { ...text, maxLength: 6000 },
    requirements: { type: 'array', maxItems: 30, items: text },
    referenceImages: { type: 'array', maxItems: 4, items: text },
    excludedTerms: { type: 'array', maxItems: 30, items: { ...text, maxLength: 200 } },
  },
};

// Explicit generation inputs are a host-reviewed visual brief. Internal history,
// technical acceptance and comparison-only images must not become provider input.
export function conceptSpecification(spec) {
  if (!spec.generationInput) return spec;
  const { prompt, requirements, referenceImages } = spec.generationInput;
  return { prompt, requirements, referenceImages, requireRig: spec.requireRig };
}

export function assertGenerationPrompt(spec, prompt) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32000) throw new Error('Invalid concept generation prompt.');
  for (const term of spec.generationInput?.excludedTerms || []) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const expression = /^[\x00-\x7f]+$/.test(term) ? `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])` : escaped;
    if (new RegExp(expression, 'iu').test(prompt)) throw Object.assign(new Error(`Final concept request violates an explicit input constraint: ${term}. Revise the host input; no provider request was made.`),
      { kind: 'GENERATION_INPUT_CONFLICT', requiresInputChange: true });
  }
  return prompt;
}

export function conceptInputIdentity(spec, referenceEvidence) {
  return hashValue(spec.generationInput
    ? { assetId: spec.assetId, input: conceptSpecification(spec), referenceEvidence }
    : { spec, referenceEvidence });
}

export function composeConceptPrompt(spec, visualBrief, repair = '') {
  const input = conceptSpecification(spec);
  return assertGenerationPrompt(spec, [
    'Create a high quality production concept for this single 3D asset: ' + input.prompt,
    visualBrief && visualBrief !== input.prompt ? 'Visible details from the designated generation references: ' + visualBrief : '',
    'Appearance requirements: ' + JSON.stringify(input.requirements),
    'Show the entire subject with all extremities, neutral studio light, plain light background, visible surface detail and separated limbs. Honor the view explicitly requested in the visual brief or current correction, including an underside or rear view; otherwise use a clear front three-quarter view.',
    spec.requireRig ? 'Use a neutral relaxed A-pose for humanoids, or a natural standing pose for animals; preserve anatomy and visible joints for later rigging.' : '',
    'Preserve the current requested design and style. No text, labels, sheet layout, multiple views, unrelated props, crop, ground pedestal or baked dramatic shadows.',
    repair ? 'Correct these independently observed defects from the preceding draft: ' + repair : '',
  ].filter(Boolean).join('\n'));
}
