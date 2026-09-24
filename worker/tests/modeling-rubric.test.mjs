import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visualRubric, visualEvidence, visualReviewPrompt } from '../agent/modeling-rubric.mjs';
import { reviewPasses } from '../agent/modeling-evaluation.mjs';
import { defaultContract, modelViews } from '../agent/modeling-contract.mjs';

test('visual PASS requires target image evidence, not author/source/reference claims', () => {
  const spec = { requirements: ['Brown body'], contract: defaultContract() };
  const evidence = visualEvidence(['ref.png', 'source.png', 'export.png'], 1, 1);
  const review = { criteria: [{ criterion: 'Brown body', status: 'PASS', evidence: 'Visible brown trunk', views: ['image-3'] }], smallEditsOnly: true, repairInstructions: '' };
  assert.equal(reviewPasses(review, spec, evidence), true);
  for (const views of [[], ['image-1'], ['image-2'], ['image-9'], ['image-3', 'image-3']]) {
    assert.throws(() => reviewPasses({ ...review, criteria: [{ ...review.criteria[0], views }] }, spec, evidence));
  }
  assert.equal(reviewPasses({ ...review, criteria: [{ ...review.criteria[0], status: 'GAP', views: [] }] }, spec, evidence), false);
});

test('rubric preserves original requirements and predeclares organic views', () => {
  const spec = { requirements: ['Roots join continuously'], contract: defaultContract({ assetClass: 'organic-static' }) };
  assert.deepEqual(visualRubric(spec).requirements.map(row => row.criterion), spec.requirements);
  assert.match(visualRubric(spec).requirements[0].roots, /Do not add a count/);
  assert.ok(modelViews(spec).includes('lower-oblique'));
  assert.match(visualReviewPrompt({ spec, evidence: [], metrics: {} }), /One first valid review/);
});
