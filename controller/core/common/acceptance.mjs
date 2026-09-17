import fs from 'node:fs';
import path from 'node:path';
import { readJson, sha256File } from './fs.mjs';

function evidenceRoot(taskDirectory) {
  return path.join(taskDirectory, 'output');
}

export function evaluateTask(task, taskDirectory) {
  const reportPath = path.join(evidenceRoot(taskDirectory), 'evidence.json');
  if (!fs.existsSync(reportPath)) return { decision: 'HOLD', reason: 'Missing sandbox evidence.json', criteria: [] };
  let report;
  try { report = readJson(reportPath); } catch (error) { return { decision: 'HOLD', reason: `Invalid evidence.json: ${error.message}`, criteria: [] }; }
  if (report.protocol !== 1 || !Array.isArray(report.criteria)) return { decision: 'HOLD', reason: 'Evidence contract is invalid', criteria: [] };
  const expected = new Set(task.acceptanceCriteria.map(criterion => criterion.id));
  const actual = new Map();
  for (const criterion of report.criteria) {
    if (!criterion?.id || actual.has(criterion.id)) return { decision: 'HOLD', reason: 'Evidence criteria are duplicated', criteria: [] };
    actual.set(criterion.id, criterion);
  }
  if (actual.size !== expected.size || [...expected].some(id => !actual.has(id))) return { decision: 'HOLD', reason: 'Evidence does not cover every acceptance criterion', criteria: [] };
  const criteria = [];
  for (const expectedCriterion of task.acceptanceCriteria) {
    const observed = actual.get(expectedCriterion.id);
    if (observed.status !== 'PASS' || !Array.isArray(observed.evidence) || observed.evidence.length === 0) {
      return { decision: observed.status === 'FAIL' ? 'FAIL' : 'HOLD', reason: `Criterion ${expectedCriterion.id} is not proven`, criteria: report.criteria };
    }
    const evidence = [];
    for (const item of observed.evidence) {
      if (typeof item.file !== 'string' || path.isAbsolute(item.file) || item.file.includes('..')) return { decision: 'HOLD', reason: `Unsafe evidence path for ${expectedCriterion.id}`, criteria: report.criteria };
      const file = path.join(evidenceRoot(taskDirectory), item.file);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return { decision: 'HOLD', reason: `Missing evidence file: ${item.file}`, criteria: report.criteria };
      const hash = sha256File(file);
      if (hash !== String(item.sha256).toLowerCase()) return { decision: 'HOLD', reason: `Evidence hash mismatch: ${item.file}`, criteria: report.criteria };
      evidence.push({ file: item.file, sha256: hash });
    }
    criteria.push({ id: expectedCriterion.id, status: 'PASS', evidence });
  }
  return { decision: 'PASS', reason: report.summary || 'All task criteria passed in sandbox.', criteria };
}

export function evaluateGlobal(plan, acceptedTasks) {
  const criteria = plan.globalCriteria.map(criterion => {
    const evidence = acceptedTasks.flatMap(task => task.criteria.flatMap(item => item.evidence));
    return { id: criterion.id, status: evidence.length ? 'PASS' : 'HOLD', evidence };
  });
  const decision = criteria.every(criterion => criterion.status === 'PASS') ? 'PASS' : 'HOLD';
  return { decision, criteria, reason: decision === 'PASS' ? 'All global criteria have sandbox evidence.' : 'Global criteria have no accepted evidence.' };
}
