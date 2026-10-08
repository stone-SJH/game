// Prompts carry current decisions and evidence locations, never accumulated logs.
// Complete requirements and reports remain available in the task workspace.
export function promptText(value, limit = 1200) {
  const text = String(value ?? '');
  return text.length <= limit ? text : text.slice(0, limit) + '… [read the complete record]';
}

export function issueSummary(issue = {}) {
  return { stage: issue.stage, status: issue.status, kind: issue.kind,
    reason: promptText(issue.reason || issue.message, 600),
    ...(issue.requiresInputChange ? { requiresInputChange: true, responseEvidence: issue.responseEvidence } : {}),
    evidenceFile: issue.evidenceFile || issue.reportFile || issue.executionFile };
}

export function productionStall(rounds, record) {
  if (!record.packageDigest || rounds.length < 3 || !rounds.slice(-3).every(row => row.score === record.score && row.packageDigest === record.packageDigest)) return null;
  const blocked = (record.modeling?.assets || []).filter(asset => asset.usable === false)
    .map(asset => ({ assetId: asset.assetId, issues: (asset.quality?.gaps || []).slice(-1).map(issueSummary) }));
  return { kind: 'PRODUCTION_STALLED', productionIncomplete: true,
    reason: 'Three completed iterations retained the same package and score without satisfying the current revision. Repair the recorded blockers before continuing; this is not an exhausted iteration budget.',
    blockedAssets: blocked, packageDigest: record.packageDigest };
}

export function modelingHandoffSummary(result = {}) {
  const assets = result.assets || [];
  return { status: result.status, reason: promptText(result.reason),
    fullRecord: 'plan/modeling-results.json', assetCount: assets.length,
    assets: assets.slice(0, 64).map(asset => ({ assetId: asset.assetId, status: asset.status,
      usable: asset.usable, route: asset.route, directory: promptText(asset.directory, 500), reused: asset.reused,
      quality: { score: asset.quality?.score, accepted: asset.quality?.accepted,
        gaps: (asset.quality?.gaps || []).slice(-3).map(issueSummary),
        repairInstructions: promptText(asset.quality?.repairInstructions, 600) } })),
    omittedAssets: Math.max(0, assets.length - 64), issues: (result.issues || []).slice(-8).map(issueSummary) };
}

export function productionFeedbackSummary(feedback) {
  if (!feedback) return null;
  return { kind: feedback.kind, action: feedback.action, stage: feedback.stage,
    reason: promptText(feedback.reason), remainingGap: feedback.remainingGap,
    repairInstructions: promptText(feedback.repairInstructions, 10000),
    criteria: (feedback.criteria || []).slice(0, 40).map(row => ({ id: row.id, status: row.status,
      reason: promptText(row.reason || row.evidence, 300) })),
    dimensions: Object.fromEntries(Object.entries(feedback.dimensions || {}).map(([key, value]) => [key,
      { status: value.status, reason: promptText(value.reason || value.evidence, 300) }])),
    diagnostics: promptText(JSON.stringify(feedback.diagnostics || []), 2000),
    fullRecord: 'plan/iteration-feedback.json' };
}

export function currentProductionResult(result, job) {
  const delivery = result?.delivery;
  return Boolean(delivery?.productionCompleted && !delivery.requiresCurrentRevisionValidation &&
    (job.revisionId ? delivery.revisionId === job.revisionId : delivery.runId === job.runId));
}
