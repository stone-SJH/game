import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createUserDecisions } from '../agent/modeling-user-decisions.mjs';
import { atomicJson, readJson, hashValue } from '../agent/modeling-io.mjs';
import { createProductionIterations } from '../agent/production-iterations.mjs';
import { validateInputRequest, validateDecisionAnswer } from '../../controller/core/input-requests.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'user-decisions-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), output = path.join(root, 'output');
  const job = { taskId: 'task-test', workspaceId: 'workspace-test', revisionId: 'revision-original', runId: 'run-original',
    objective: 'Create a woodland adventure.', controllerCapabilities: { userDecisions: 1 } };
  const plan = { reason: 'Approved design', assets: [{ assetId: 'fox', prompt: 'A silver woodland fox.', requirements: [],
    referenceImages: [], generationInput: { prompt: 'A silver woodland fox.', requirements: [], referenceImages: [] } }] };
  const planFile = path.join(project, 'plan/modeling-plan.json'); await atomicJson(planFile, plan);
  const feedback = { blockedAssets: [{ assetId: 'fox', issues: [{ stage: 'concept-image', input: { prompt: 'A silver woodland fox.', provider: 'image', referenceImages: [] },
    response: { code: 'moderation_blocked', requestId: 'provider-request' } }] }] };
  const manager = createUserDecisions({ job, project, output });
  const question = await manager.fromGeneration(feedback); validateInputRequest(question);
  const response = validateDecisionAnswer(question, { requestId: question.requestId, revisionId: question.revisionId,
    basePlanHash: question.basePlanHash, effectiveInputHash: question.effectiveInputHash, idempotencyKey: 'answer-00001',
    text: 'An original copper creature, four broad paws and rounded ears.', optionId: 'revise-design', grantNewBudget: false });
  const nextJob = { ...job, revisionId: 'revision-answer', runId: 'run-answer', payload: {
    budgetRevisionId: job.revisionId, inputAnswer: { protocol: 1, request: question, answer: response, answerId: 'answer-00001' }, followUpPrompt: response.instruction } };
  return { root, project, output, job, nextJob, plan, planFile, question, feedback, manager };
}
test('old controllers retain legacy behavior; identical published evidence retains one immutable question', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.manager.fromGeneration(f.feedback), f.question);
  for (let n = 0; n < 2; n++) await assert.rejects(f.manager.beforeWork(), error => error.inputRequest.requestId === f.question.requestId);
  const legacy = createUserDecisions({ ...f, job: { ...f.job, controllerCapabilities: {} } });
  assert.equal(await legacy.fromGeneration(f.feedback), null); await legacy.beforeWork();
  const tripo = structuredClone(f.feedback); tripo.blockedAssets[0].issues[0].input = { provider: 'tripo', prompt: null,
    image: { path: 'art/concept.png', sha256: 'a'.repeat(64) } };
  tripo.blockedAssets[0].issues[0].response = { providerCode: 2008 };
  const request = await f.manager.fromGeneration(tripo); validateInputRequest(request);
  assert.equal(request.generationInput.code, '2008'); assert.equal(request.generationInput.submittedImage.path, 'art/concept.png');
});

test('insufficient or stale answers produce a linked question before production reservations and never reset budget', async t => {
  const f = await fixture(t), policy = { maxIterations: 10 };
  const ledger = await createProductionIterations({ ...f, policy }); await ledger.reserveAttempt();
  let reviews = 0, reconciles = 0;
  const args = { ...f, job: f.nextJob, review: async () => { reviews++; return { approved: false, reason: 'The new appearance is still ambiguous. Provide the complete replacement.' }; },
    reconcile: async () => { reconciles++; } };
  let next;
  await assert.rejects(createUserDecisions(args).beforeWork(), error => { next = error.inputRequest; return error.kind === 'USER_INPUT_REQUIRED'; });
  assert.equal(next.parentRequestId, f.question.requestId); assert.equal(next.revisionId, f.nextJob.revisionId); validateInputRequest(next);
  await assert.rejects(createUserDecisions(args).beforeWork(), error => error.inputRequest.requestId === next.requestId);
  assert.equal(reviews, 1); assert.equal(reconciles, 0);
  const inherited = await createProductionIterations({ ...f, job: f.nextJob, policy }); assert.equal(inherited.attempts, 1);
  const granted = await createProductionIterations({ ...f, job: { ...f.nextJob, payload: { ...f.nextJob.payload, budgetRevisionId: f.nextJob.revisionId } }, policy });
  assert.equal(granted.attempts, 0); assert.equal(ledger.attempts, 1);
  await assert.rejects(createProductionIterations({ ...f, job: { ...f.nextJob, payload: { ...f.nextJob.payload, budgetRevisionId: 'missing-budget' } }, policy }), /inherited production budget is missing/);
});

test('reviewed answer is restartable after plan activation and later questions are not bypassed by its receipt', async t => {
  const f = await fixture(t); let reconciles = 0, reviews = 0, firstPrompt;
  const amended = structuredClone(f.plan); amended.assets[0].generationInput.prompt = 'An original copper creature with rounded ears.';
  const args = { ...f, job: f.nextJob, review: async (name, schema, prompt) => {
    reviews++; firstPrompt ||= prompt; assert.equal(prompt, firstPrompt); return { approved: true, reason: 'Complete authorized visual replacement.' };
  }, reconcile: async () => {
    reconciles++;
    await atomicJson(f.planFile, amended);
    await atomicJson(path.join(f.project, 'plan/modeling-user-revision.json'), { status: 'APPLIED', revisionId: f.nextJob.revisionId,
      before: f.plan, beforeHash: hashValue(f.plan), appliedHash: hashValue(amended) });
    if (reconciles === 1) throw new Error('Simulated process interruption after durable activation');
  } };
  await assert.rejects(createUserDecisions(args).beforeWork(), /Simulated process interruption/);
  await createUserDecisions(args).beforeWork(); await createUserDecisions(args).beforeWork();
  assert.equal(reviews, 2); assert.equal(reconciles, 2); assert.equal(await readJson(path.join(f.root, 'decision-state/pending.json')), null);
  const manager = createUserDecisions(args), newFeedback = structuredClone(f.feedback);
  newFeedback.blockedAssets[0].issues[0].input.prompt = amended.assets[0].generationInput.prompt;
  const next = await manager.fromGeneration(newFeedback);
  await assert.rejects(manager.beforeWork(), error => error.inputRequest.requestId === next.requestId);
  assert.equal(reconciles, 2);
});

test('stale basis and unchanged effective visual input ask for clarification without author or provider calls', async t => {
  const f = await fixture(t); let reviews = 0, reconciles = 0;
  const args = { ...f, job: f.nextJob, review: async () => { reviews++; return { approved: true, reason: 'Proposed revision is clear.' }; },
    reconcile: async () => { reconciles++; } };
  await assert.rejects(createUserDecisions(args).beforeWork(), error => /did not change/.test(error.inputRequest.reason));
  assert.equal(reconciles, 1);
  const stale = await fixture(t); await atomicJson(stale.planFile, { ...stale.plan, reason: 'A different approved contract' });
  await assert.rejects(createUserDecisions({ ...args, ...stale, job: stale.nextJob }).beforeWork(), error => /active plan changed/.test(error.inputRequest.reason));
  assert.equal(reviews, 1); assert.equal(reconciles, 1);
});

test('system-owned defects and rejected proposals never become user approval; authentic evidence is required', async t => {
  const f = await fixture(t); const calls = [];
  const proposal = { needsUserDecision: false, kind: 'scope-choice', assetIds: [], title: 'Repair validator', reason: 'Tool defect', expected: 'Working validator', actual: 'Unsupported validation', options: f.question.options };
  const args = { ...f, review: async name => { calls.push(name); return name === 'user-decision-proposal' ? proposal : { approved: false, reason: 'System repair is required.' }; } };
  assert.equal(await createUserDecisions(args).reviewBlocker(null, { failure: 'validator defect' }), null);
  assert.deepEqual(calls, ['user-decision-proposal']); proposal.needsUserDecision = true;
  assert.equal(await createUserDecisions(args).reviewBlocker(null, { failure: 'validator defect' }), null);
  assert.equal(calls.at(-1), 'user-decision-proposal-review');
  const count = calls.length;
  assert.equal(await createUserDecisions(args).reviewBlocker({ assets: [{ assetId: 'broken-tool', usable: false,
    quality: { gaps: [{ kind: 'SERVICE_CONFIGURATION', reason: 'Tool missing' }] } }] }), null);
  assert.equal(calls.length, count, 'a tool outage without measured source does not trigger a preference review');
  await fs.appendFile(path.join(f.project, f.question.evidence[0].path), 'changed');
  await assert.rejects(createUserDecisions({ ...args, job: f.nextJob }).beforeWork(), error => error.kind === 'INTEGRITY_ERROR');
});

test('project scope decisions survive a resumed production run without a modeling plan', async t => {
  const f = await fixture(t); await fs.rm(f.planFile);
  await atomicJson(path.join(f.project, 'plan/production-plan.json'), { taskId: f.job.taskId, runId: f.job.runId, stages: [{ id: 'level-design' }] });
  const proposal = { needsUserDecision: true, kind: 'scope-choice', title: 'Choose level size', reason: 'Two approved scope goals conflict.',
    expected: 'A compact level and a large exploration area.', actual: 'Both goals require a scope choice.', assetIds: [],
    options: f.question.options.map(option => ({ ...option, requiresText: false })) };
  const manager = createUserDecisions({ ...f, review: async name => name === 'user-decision-proposal' ? proposal : { approved: true, reason: 'Concrete user scope choice.' } });
  const question = await manager.reviewBlocker(null, { conflict: 'Compact versus expansive' });
  await atomicJson(path.join(f.project, 'plan/production-plan.json'), { taskId: f.job.taskId, runId: f.nextJob.runId, stages: [{ id: 'level-design' }] });
  const job = { ...f.nextJob, payload: { inputAnswer: { request: question, answer: { instruction: 'Build a compact level.' } } } };
  await createUserDecisions({ ...f, job, review: async () => ({ approved: true, reason: 'User selected a compact level.' }) }).beforeWork();
  assert.equal(await readJson(path.join(f.root, 'decision-state/pending.json')), null);
});

test('a new explicit budget after answer revisions inherits the previous package from the original budget ledger', async t => {
  const f = await fixture(t), policy = { maxIterations: 10 };
  const original = await createProductionIterations({ ...f, policy });
  const preview = path.join(f.project, 'preview.txt'); await fs.writeFile(preview, 'retained evidence');
  await original.reserveAttempt();
  await original.complete({ deliverables: { files: { preview } }, score: 50, threshold: 85, qualityAccepted: false, issues: [] });
  const next = await createProductionIterations({ ...f, policy, job: { ...f.nextJob, revisionId: 'grant-revision', parentRevisionId: f.nextJob.revisionId,
    payload: { budgetRevisionId: 'grant-revision', parentBudgetRevisionId: f.job.revisionId } } });
  assert.equal(next.attempts, 0); assert.equal((await next.best()).delivery.score, 50);
  assert.equal((await next.best()).delivery.requiresCurrentRevisionValidation, true);
  assert.equal(original.attempts, 1);
});
