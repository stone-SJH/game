// Isolated natural-language probe: planning by default, optional complete local production.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createModelingPipeline } from '../agent/modeling-pipeline.mjs';
import { codexInvocation, runProductionHarness } from '../agent/production-harness.mjs';
import { runCommand } from '../agent/process-runner.mjs';
import { atomicJson, readJson, hashFile, localPath } from '../agent/modeling-io.mjs';

const argv = process.argv.slice(2), options = {};
for (let i = 0; i < argv.length; i += 2) {
  if (!['--context', '--objective', '--draft', '--out', '--mode'].includes(argv[i]) || !argv[i + 1]) throw new Error('Use --context FILE or --objective TEXT, optionally --draft FILE, --out NEW_DIRECTORY, --mode planning|production.');
  options[argv[i].slice(2)] = argv[i + 1];
}
if (Boolean(options.context) === Boolean(options.objective)) throw new Error('Choose exactly one context file or natural-language objective.');
const mode = options.mode || 'planning';
if (!['planning', 'production'].includes(mode) || mode === 'production' && options.draft) throw new Error('Production probes require fresh intake, not a retained draft.');
const context = options.context ? await readJson(path.resolve(options.context)) : { objective: options.objective, references: [] };
const originalHash = options.context ? await hashFile(path.resolve(options.context)) : null;
const draft = options.draft ? await readJson(path.resolve(options.draft)) : null;
const root = options.out ? path.resolve(options.out) : await fs.mkdtemp(path.join(os.tmpdir(), 'engineering-intake-live-'));
if (options.out) await fs.mkdir(root, { recursive: false });
const project = path.join(root, 'project'), output = path.join(root, 'run');
await fs.mkdir(project); await fs.mkdir(output);
for (const reference of context.references || []) {
  const source = await localPath(context.workspaceRoot, reference.localPath, { existing: true });
  if (await hashFile(source) !== reference.sha256) throw new Error('Original reference changed.');
  const destination = await localPath(project, reference.localPath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
}
const abort = new AbortController(), started = Date.now(), id = crypto.randomUUID();
process.on('SIGINT', () => abort.abort(new Error('Probe interrupted')));
process.env.MODELING_HARNESS_V2_ENABLED = '1';
const stop = new Error('Engineering complete; probe stops before authoring.');
const calls = [];
console.log(JSON.stringify({ event: 'started', mode, root, sourceTaskId: context.taskId, retainedDraft: Boolean(draft) }));
const pipelineOptions = { project, output, signal: abort.signal, invocation: codexInvocation([]),
  job: { taskId: `engineering-probe-${id}`, workspaceId: id, runId: 'probe', objective: context.objective,
    referenceFiles: context.references || [], qualityCriteria: context.qualityCriteria || [], deadlineAt: new Date(started + 45 * 60000).toISOString() },
  evaluate: async ({ name }) => name === 'modeling-plan' && draft ? draft : undefined,
  probe: async () => { throw stop; },
  step: async (name, command, args, timeoutMs, cwd, accepts, extra = {}) => {
    timeoutMs = Math.min(timeoutMs, started + 45 * 60000 - Date.now());
    if (timeoutMs <= 0) throw new Error('Isolated probe deadline exhausted.');
    console.log(JSON.stringify({ event: 'call-started', name, timeoutMs }));
    const result = await runCommand(command, args, { ...extra, cwd, timeoutMs, signal: abort.signal,
      stdoutFile: path.join(output, `${name}.stdout.jsonl`), stderrFile: path.join(output, `${name}.stderr.log`) });
    await atomicJson(path.join(output, `${name}.json`), result);
    calls.push({ name, exitCode: result.exitCode, timedOut: result.timedOut, stopConfirmed: result.stopConfirmed });
    console.log(JSON.stringify({ event: 'call-finished', ...calls.at(-1) }));
    if (!result.stopConfirmed || result.exitCode !== 0 || result.error || result.timedOut || result.canceled) {
      throw Object.assign(new Error(`${name}: ${result.timedOut ? 'timeout' : result.error || `exit ${result.exitCode}`}`), { result });
    }
    if (accepts && !await accepts(result)) throw Object.assign(new Error(`${name}: acceptance failed`), { result });
    return result;
  } };
let error, delivered;
try {
  if (mode === 'production') delivered = await runProductionHarness({ ...pipelineOptions, unreal: process.env.UNREAL_CMD });
  else await createModelingPipeline(pipelineOptions).prepare();
} catch (caught) { if (caught !== stop) error = caught; }
const plan = await readJson(path.join(project, 'plan/modeling-specs.json'));
const engineering = await readJson(path.join(project, 'plan/engineering-plan.json'));
const report = { mode, sourceTaskId: context.taskId || null, root, durationMs: Date.now() - started, calls,
  passed: !error && Boolean(plan) && Boolean(engineering) && (mode === 'planning' || Boolean(delivered)),
  delivered: delivered?.files,
  sourceUnchanged: !options.context || originalHash === await hashFile(path.resolve(options.context)),
  assetCount: plan?.assets?.length, traversalAssets: plan?.assets?.filter(asset => asset.contract?.traversal).map(asset => asset.assetId),
  requirements: engineering?.requirements?.length, error: error?.message, kind: error?.kind, lastFailure: error?.lastFailure };
await atomicJson(path.join(root, 'probe-report.json'), report);
console.log(JSON.stringify(report));
process.exitCode = report.passed && report.sourceUnchanged ? 0 : 1;
