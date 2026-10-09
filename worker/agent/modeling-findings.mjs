// Keep root causes in bounded handoffs; full reports and failed attempts remain immutable.
const bounded = value => {
  if (value === undefined) return undefined;
  const serialized = JSON.stringify(value);
  return serialized.length <= 1600 ? value : serialized.slice(0, 1600) + ' [read full evidence]';
};

export function modelingFindings(feedback) {
  const findings = [];
  function visit(value, location = '', depth = 0) {
    if (!value || typeof value !== 'object' || depth > 5 || findings.length >= 12) return;
    if (Array.isArray(value)) { for (let i = 0; i < Math.min(value.length, 80); i++) visit(value[i], location, depth + 1); return; }
    if (value.id && ['GAP', 'FAIL'].includes(value.status)) {
      const actual = value.id === 'traversal' ? { status: value.actual?.status, reason: value.actual?.reason,
        paths: value.actual?.paths?.filter(row => row.status !== 'PASS').slice(0, 8) } : value.actual;
      findings.push({ scope: location, id: value.id, status: value.status,
        expected: bounded(value.expected), actual: bounded(actual), tolerance: bounded(value.tolerance),
        reason: bounded(value.reason || value.evidence) });
      return;
    }
    for (const key of ['source', 'export', 'exported', 'fbx', 'runtime', 'gates', 'criteria']) {
      if (value[key]) visit(value[key], [location, key].filter(Boolean).join('.'), depth + 1);
    }
  }
  visit(feedback);
  return findings;
}
