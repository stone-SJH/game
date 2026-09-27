// Scores describe observed acceptance coverage; provisional delivery never changes a GAP to PASS.
export function criterionScore(criteria, fallback = 0) {
  const rows = (criteria || []).filter(row => row.status !== 'NOT_APPLICABLE');
  return rows.length ? Math.round(100 * rows.filter(row => row.status === 'PASS').length / rows.length) : fallback;
}

export function assetQuality(review, passed = false) {
  return { score: criterionScore(review?.criteria, passed ? 100 : 0), accepted: passed,
    gaps: (review?.criteria || []).filter(row => row.status !== 'PASS'),
    repairInstructions: review?.repairInstructions || '' };
}

export function iterationScore({ quality, modeling, stages = [], issues = [] }) {
  const scores = [];
  if (quality?.criteria?.length) scores.push(criterionScore(quality.criteria));
  if (quality?.dimensions) scores.push(criterionScore(Object.values(quality.dimensions), 100));
  if (modeling?.assets?.length) scores.push(Math.round(modeling.assets.reduce((n, asset) => n + (asset.quality?.score ?? (asset.status === 'DCC_READY' ? 100 : 0)), 0) / modeling.assets.length));
  if (stages.length) scores.push(Math.round(stages.reduce((n, stage) => n + stage.score, 0) / stages.length));
  else if (issues.length) scores.push(0);
  return scores.length ? Math.min(...scores) : 100;
}
