import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelingHandoffSummary, productionFeedbackSummary, currentProductionResult, productionStall, issueSummary } from '../agent/production-prompt.mjs';

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

test('three unchanged packages report the asset blocker and do not claim budget exhaustion or quality completion', () => {
  const round = { score: 0, packageDigest: 'same-package' };
  const record = { ...round, modeling: { assets: [{ assetId: 'player', usable: false,
    quality: { gaps: [{ kind: 'IMAGE_INPUT_REJECTED', requiresInputChange: true, reason: 'Current input rejected.' }] } }] } };
  assert.equal(productionStall([round, round], record), null);
  assert.equal(productionStall([round, round, { ...round, packageDigest: 'new-package' }], record), null);
  const stopped = productionStall([round, round, round], record);
  assert.equal(stopped.kind, 'PRODUCTION_STALLED'); assert.equal(stopped.productionIncomplete, true);
  assert.equal(stopped.blockedAssets[0].issues[0].requiresInputChange, true);
});

test('large failed-gate payloads are bounded in prompts while retained evidence remains complete', () => {
  const issue = { kind: 'TECHNICAL_GAP', feedbackEvidence: { reportFile: 'geometry.json' }, findings: Array.from({ length: 12 }, () => ({
    id: 'dimensions', scope: 'source.gates', expected: 'x'.repeat(30000), actual: Array(200).fill('y'.repeat(30000)), tolerance: 'z'.repeat(30000),
  })) };
  const summarized = issueSummary(issue);
  assert.equal(summarized.findings.length, 2);
  assert.ok(JSON.stringify(summarized).length < 1100);
  assert.equal(summarized.evidenceFile, 'geometry.json');
  assert.equal(issue.findings.length, 12); assert.equal(issue.findings[0].actual.length, 200);
});
