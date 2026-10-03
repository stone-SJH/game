import fs from 'node:fs/promises';
import path from 'node:path';
import { localPath, readJson, hashValue } from './modeling-io.mjs';
import { fileEvidence, verifyEvidence, modelingFailure } from './modeling-execution.mjs';

// Recover outputs, never the expired author reservation. Host technical and visual
// validation still own acceptance and retain their original call/time limits.
export async function retainedFinalForValidation({ project, stateRoot, state, execution }) {
  if (!state.spec?.contract || state.route !== 'blender_direct' || state.accepted ||
      state.pending && state.pending.phase !== 'FINAL_PENDING') return null;
  const attempt = state.attempts?.blender_direct;
  if (!Number.isSafeInteger(attempt) || attempt < 1) return null;
  const short = state.requirementsHash.slice(0, 20);
  const attemptId = `${state.spec.assetId}-${short}-blender_direct-${attempt}`;
  const failed = state.failures?.at(-1);
  const timeoutKinds = new Set(['AUTHOR_TIMEOUT', 'SERVICE_TRANSIENT']); // Older hosts mislabeled this timeout.
  if (failed?.attemptId !== attemptId || failed.phase !== 'FINAL_PENDING' ||
      !timeoutKinds.has(failed.kind) || !failed.timedOut || failed.canceled || failed.stopConfirmed !== true || state.finalAuthorRecoveries?.[attemptId]) return null;
  await execution.assertSettled();
  const ledger = await execution.snapshot(), groups = Object.values(ledger.groups);
  const final = groups.find(g => g.key === `author:${attemptId}-final`);
  const call = final?.calls.at(-1);
  if (final?.completed || call?.status !== 'FAILED' || !call.error?.timedOut ||
      !timeoutKinds.has(call.error.kind) || call.error.canceled || call.error.stopConfirmed !== true) return null;
  // Once validation has reserved anything, its own recovery rules apply.
  if (groups.some(g => [`technical:${attemptId}`, `visual:${attemptId}`].includes(g.key))) return null;
  const blockout = groups.find(g => g.key === `author:${attemptId}-blockout`);
  if (!blockout?.completed || !blockout.result?.evidence?.length || !blockout.result.receiptFile?.endsWith('.blockout.json')) return null;
  await verifyEvidence(blockout.result.evidence);
  const workspace = path.dirname(project);
  const receiptFile = await localPath(workspace, path.relative(workspace, blockout.result.receiptFile.slice(0, -'.blockout.json'.length)), { existing: true });
  const receipt = await readJson(receiptFile);
  if (!receipt?.calls?.length || receipt.calls.some(c => c.stopConfirmed !== true))
    throw modelingFailure('STOP_UNCONFIRMED', 'Retained author has an unconfirmed Blender process.', { stopConfirmed: false });
  const scripts = receipt.calls.filter(c => c.tool === 'blender_run_python');
  const last = scripts.at(-1);
  if (!last || last.exitCode !== 0 || last.timedOut || last.canceled) return null;
  const scriptEvidence = [];
  for (const call of scripts) {
    if (!call.scriptFile || !call.scriptHash) return null;
    scriptEvidence.push({ file: await localPath(project, call.scriptFile, { existing: true }), sha256: call.scriptHash });
  }
  await verifyEvidence(scriptEvidence);
  const snapshotFile = await localPath(stateRoot, `blockout-evidence/${hashValue(attemptId)}/manifest.json`, { existing: true });
  const snapshot = await readJson(snapshotFile);
  if (![1, 2].includes(snapshot?.protocol) || snapshot.attemptId !== attemptId || !snapshot.rows?.length)
    throw modelingFailure('INTEGRITY_ERROR', 'Missing frozen blockout identity for retained final.');
  const frozen = [];
  for (const row of snapshot.rows) frozen.push({ file: await localPath(project, row.path, { existing: true }), sha256: row.sha256 });
  await verifyEvidence(frozen);
  const directory = `art/models/${state.spec.assetId}/${short}/blender_direct-${attempt}`;
  const required = ['source.blend', 'model.glb', 'recipe.py', 'asset-manifest.json', 'build-report.json',
    ...(state.spec.contract.runtime.profile.startsWith('fbx') ? ['model.fbx'] : [])];
  for (const name of required) {
    const file = await localPath(project, `${directory}/${name}`);
    const stat = await fs.stat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!stat?.isFile() || !stat.size) return null;
    if (name.endsWith('.json')) {
      try { if (!await readJson(file)) return null; } catch (error) { if (!(error instanceof SyntaxError)) throw error; return null; }
    }
  }
  const files = [];
  async function collect(relative) {
    for (const entry of await fs.readdir(await localPath(project, relative, { existing: true }), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw modelingFailure('INTEGRITY_ERROR', 'Retained author output contains a link.');
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await collect(child);
      else files.push(await localPath(project, child, { existing: true }));
    }
  }
  await collect(directory);
  const artifactEvidence = await fileEvidence([...files, receiptFile, snapshotFile, ...scriptEvidence.map(r => r.file), ...frozen.map(r => r.file)]);
  return { attempt, attemptId, route: 'blender_direct', receiptFile, sourceFile: null, phase: 'TECHNICAL_PENDING',
    stageArtifacts: [...new Set([...snapshot.rows.map(r => r.path), ...scripts.map(c => c.scriptFile)])], artifactEvidence,
    recovery: { kind: 'RETAINED_FINAL_AFTER_AUTHOR_TIMEOUT', callId: call.callId, originalFailure: failed,
      acceptance: 'Unvalidated retained outputs; run the original host technical and visual gates.' } };
}
