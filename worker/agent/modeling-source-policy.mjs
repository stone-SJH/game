import fs from 'node:fs/promises';
import path from 'node:path';
import { readModelingState } from './modeling-state.mjs';

const externalRoutes = new Set(['image_tripo_blender', 'tripo_then_blender']);

export function modelingSourcePolicy(job = {}, spec = {}) {
  const text = [job.objective, job.payload?.followUpPrompt, spec.description, spec.prompt, ...(spec.requirements || [])].filter(Boolean).join('\n');
  const forbidden = /(?:不得|禁止|不允许|不能|不要|不调用)[^。\n；;]{0,45}(?:外部\s*3\s*d|第三方\s*3\s*d|tripo)|(?:no|never|must\s+not|do\s+not|don.t|forbid\w*|prohibit\w*)[^.\n;]{0,65}(?:(?:external|third.party)\s*3\s*d|tripo)/i.test(text);
  return { external3DAllowed: !forbidden, reason: forbidden ? 'User constraints prohibit external 3D generation; author directly in Blender.' : null };
}

export function generatedCandidate(candidate) {
  return Boolean(candidate && (candidate.generation || externalRoutes.has(candidate.route) ||
    /tripo|image.to.3d|generation provider/i.test([candidate.source, candidate.license, candidate.modelingMetadata?.route, candidate.metadata?.route].join(' '))));
}

// Keep historical candidates and all counters. Only the next source selection changes.
export function enforceSourcePolicy(state, policy, iteration) {
  if (policy.external3DAllowed) return false;
  const changed = externalRoutes.has(state.route) || generatedCandidate(state.accepted) || generatedCandidate(state.bestCandidate);
  if (!changed) return false;
  if (state.pending && state.pending.phase !== 'ACCEPTED') throw Object.assign(new Error('A prohibited generated-source attempt must be settled before direct authoring.'), { kind: 'SOURCE_POLICY_PENDING', executionFence: true });
  state.sourcePolicyTransitions ||= [];
  state.sourcePolicyTransitions.push({ iteration, from: state.route, to: 'blender_direct', reason: policy.reason,
    accepted: state.accepted || null, bestCandidate: state.bestCandidate || null });
  if (generatedCandidate(state.accepted)) state.accepted = null;
  if (generatedCandidate(state.bestCandidate)) state.bestCandidate = null;
  state.route = 'blender_direct';
  state.decision = { route: 'blender_direct', editPlan: ['Author geometry, UVs and baked materials directly in Blender.'], reason: policy.reason };
  state.source = null; state.previousAttemptDirectory = null; state.pending = null;
  return true;
}

export function sourcePolicyAttempts(state, attempts, route, policy = {}) {
  // A route correction cannot refund attempts spent on the prohibited route.
  return route === 'blender_direct' && (state.sourcePolicyTransitions?.length || policy.external3DAllowed === false)
    ? Object.values(attempts).reduce((sum, n) => sum + n, 0) : attempts[route] || 0;
}

export async function otherRevisionAttempts(root, stateFile, assetId, revisionId) {
  const totals = {};
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{20}$/.test(entry.name)) continue;
    const file = path.join(root, entry.name, 'state.json');
    if (path.resolve(file) === path.resolve(stateFile)) continue;
    const state = await readModelingState(file);
    if (state?.spec?.assetId !== assetId) continue;
    for (const [route, count] of Object.entries(state.revisionBudgets?.[revisionId]?.attempts || state.rounds?.[revisionId]?.attempts || {})) totals[route] = (totals[route] || 0) + count;
  }
  return totals;
}
