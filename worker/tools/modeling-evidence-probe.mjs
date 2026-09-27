// Review retained models with fresh reference research, without changing the original task.
import fs from 'node:fs/promises';
import path from 'node:path';
import { codexInvocation } from '../agent/production-harness.mjs';
import { runCommand } from '../agent/process-runner.mjs';
import { createExecutionStore, fileEvidence, verifyEvidence } from '../agent/modeling-execution.mjs';
import { createModelingReviewer } from '../agent/modeling-review.mjs';
import { prepareModelingReferences } from '../agent/modeling-research.mjs';
import { authorEvidence, engineeringEvidence } from '../agent/modeling-evidence.mjs';
import { visualEvidence, visualReviewPrompt } from '../agent/modeling-rubric.mjs';
import { visualSchemaFor, reviewPasses } from '../agent/modeling-evaluation.mjs';
import { atomicJson, localPath, readJson, repositoryRoot } from '../agent/modeling-io.mjs';
import { blenderExecutable } from '../agent/modeling-capabilities.mjs';

const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--project', '--asset', '--directory', '--out', '--research-record'].includes(args[i]) || !args[i+1]) throw new Error('Use --project ORIGINAL_PROJECT --asset ASSET_ID --directory RELATIVE_MODEL_DIRECTORY --out NEW_DIRECTORY [--research-record RETAINED_BLOCKER_JSON]');
  options[args[i].slice(2)] = args[i+1];
}
if (!['project', 'asset', 'directory', 'out'].every(key => options[key])) throw new Error('All four probe options are required.');
const original = path.resolve(options.project), root = path.resolve(options.out);
if (root === original || root.startsWith(original + path.sep)) throw new Error('Probe output must be outside the original project.');
await fs.mkdir(root, { recursive: false });
const project = path.join(root, 'project'), output = path.join(root, 'run');
await fs.mkdir(project); await fs.mkdir(output);
const directory = await localPath(original, options.directory, { existing: true });
const plan = await readJson(await localPath(original, 'plan/modeling-specs.json', { existing: true }));
const engineering = await readJson(await localPath(original, 'plan/engineering-plan.json'));
let spec = plan.assets.find(row => row.assetId === options.asset);
if (!spec) throw new Error('Asset not found in retained plan.');
const supplement = await authorEvidence(original, options.directory);
const before = await fileEvidence([...supplement.files, ...['source.blend', 'model.glb', 'model.fbx', 'asset-manifest.json'].map(name => path.join(directory, name))]);
for (const relative of spec.referenceImages) {
  const file = await localPath(original, relative, { existing: true });
  const target = await localPath(project, relative);
  await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(file, target);
}
const abort = new AbortController(); process.on('SIGINT', () => abort.abort());
const started = Date.now(), calls = [];
const execution = createExecutionStore(path.join(root, 'execution'), { signal: abort.signal, deadlineAt: new Date(started + 45*60000).toISOString() });
async function step(name, command, argv, timeoutMs, cwd, accepts, extra = {}) {
  console.log(JSON.stringify({ event: 'started', name }));
  const result = await runCommand(command, argv, { ...extra, cwd, timeoutMs, signal: abort.signal,
    stdoutFile: path.join(output, name+'.stdout.jsonl'), stderrFile: path.join(output, name+'.stderr.log') });
  await atomicJson(path.join(output, name+'.json'), result);
  calls.push({ name, exitCode: result.exitCode, timedOut: result.timedOut, stopConfirmed: result.stopConfirmed });
  console.log(JSON.stringify(calls.at(-1)));
  if (result.exitCode !== 0 || result.error || result.timedOut || result.canceled || !result.stopConfirmed) throw Object.assign(new Error(name+' failed'), { result });
  return result;
}
const review = createModelingReviewer({ project, output, execution, signal: abort.signal, step, invocation: codexInvocation([]) });
if (options['research-record']) {
  const retained = await readJson(path.resolve(options['research-record']));
  if (!retained?.inputHash || retained.references?.length || !retained.blocked?.length || retained.evidence?.length) throw new Error('Only a retained research blocker without image outputs can be replayed.');
  await atomicJson(path.join(project, 'plan/modeling-references', retained.inputHash.slice(0,20), 'research.json'), retained);
  await atomicJson(path.join(root, 'research-replay.json'), { source: path.resolve(options['research-record']), evidence: await fileEvidence([path.resolve(options['research-record'])]) });
}
let result;
try {
  const prepared = await prepareModelingReferences({ assets: [spec], project, job: { objective: engineering?.objective || spec.prompt }, engineering,
    review: (name, schema, prompt, images, options) => review({ name, schema, prompt, images, ...options }), reportProgress: async event => console.log(JSON.stringify(event)) });
  spec = prepared.assets[0];
  const specFile = path.join(root, 'spec.json'), reportFile = path.join(root, 'geometry/geometry-report.json');
  await atomicJson(specFile, spec);
  await step('technical', blenderExecutable(), ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python',
    path.join(repositoryRoot, 'worker/tools/modeling-asset-check.py'), '--', '--directory', directory, '--spec', specFile, '--report', reportFile, '--workspace', original], 300000, project);
  const geometry = await readJson(reportFile);
  if (!geometry.passed) throw new Error('Retained asset failed independent technical checks.');
  const labels = [...spec.referenceImages.map(file => path.join(project, file)), ...geometry.views.map(row => row.file),
    ...geometry.lodViews.map(row => row.file), ...supplement.images.map(file => path.join(original, file))];
  const evidence = visualEvidence(labels, spec.referenceImages.length);
  if (supplement.images.length) for (const row of evidence.slice(-supplement.images.length)) row.role = 'author-supplement';
  const prompt = visualReviewPrompt({ spec, evidence, metrics: geometry, context: {
    engineering: engineeringEvidence(engineering, spec.assetId), references: prepared.record?.references || [], authorReports: supplement.reports } });
  const reviewed = await review({ name: 'modeling-visual-review', schema: visualSchemaFor(spec, evidence), prompt, images: labels,
    referenceFiles: supplement.files, validate: value => reviewPasses(value, spec, evidence) });
  await verifyEvidence(before);
  result = { probePassed: true, assetPassed: reviewPasses(reviewed, spec, evidence), sourceUnchanged: true,
    referenceCount: spec.referenceImages.length, supplementalImages: supplement.images.length,
    collisionCount: geometry.fbx?.collision.count, lodViews: geometry.lodViews.length,
    review: reviewed, calls, durationMs: Date.now()-started };
} catch (error) {
  await verifyEvidence(before);
  result = { probePassed: false, sourceUnchanged: true, error: error.message, kind: error.kind, calls, durationMs: Date.now()-started };
}
await atomicJson(path.join(root, 'probe-report.json'), result);
console.log(JSON.stringify(result));
process.exitCode = result.probePassed ? 0 : 1;
