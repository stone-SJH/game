import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelingHandoffSummary, productionFeedbackSummary, currentProductionResult } from '../agent/production-prompt.mjs';

test('large retained modeling histories cannot consume the production input budget', () => {
  const message = 'historical tool failure '.repeat(100000);
  const asset = { assetId: 'monk', status: 'NO_USABLE_ARTIFACT', usable: false, failures: [{ message }],
    files: Array(100).fill({ path: 'retained-output', sha256: 'a'.repeat(64) }),
    quality: { accepted: false, score: 0, gaps: [{ reason: message, stage: 'PREVIEW' }], repairInstructions: message } };
  const result = { assets: Array.from({ length: 80 }, (_, i) => ({ ...asset, assetId: 'asset-' + i })), reason: message };
  const feedback = { repairInstructions: message, criteria: Array(100).fill({ id: 'required', evidence: message, status: 'GAP' }) };
  const handoff = modelingHandoffSummary(result), brief = productionFeedbackSummary(feedback);
  assert.ok(JSON.stringify({ handoff, brief }).length < 128000);
  assert.equal(handoff.assetCount, 80); assert.equal(handoff.omittedAssets, 16);
  assert.equal(handoff.fullRecord, 'plan/modeling-results.json');
  assert.equal(brief.fullRecord, 'plan/iteration-feedback.json');
  assert.equal(result.assets[0].failures[0].message, message);
  assert.equal(feedback.repairInstructions, message);
});

test('legacy or inherited packages cannot satisfy execution of the current revision', () => {
  const job = { revisionId: 'new', runId: 'run' };
  const result = { delivery: { revisionId: 'old', productionCompleted: true, runId: 'old-run' } };
  assert.equal(currentProductionResult(result, job), false);
  result.delivery.revisionId = 'new'; result.delivery.requiresCurrentRevisionValidation = true;
  assert.equal(currentProductionResult(result, job), false);
  delete result.delivery.requiresCurrentRevisionValidation;
  assert.equal(currentProductionResult(result, job), true);
  delete result.delivery.productionCompleted;
  assert.equal(currentProductionResult(result, job), false);
});
