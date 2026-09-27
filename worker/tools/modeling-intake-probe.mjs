// Isolated planning/production, or host acceptance of a copied retained real project.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createModelingPipeline } from '../agent/modeling-pipeline.mjs';
import { codexInvocation, runProductionHarness } from '../agent/production-harness.mjs';
import { runCommand } from '../agent/process-runner.mjs';
import { atomicJson, readJson, hashFile, localPath } from '../agent/modeling-io.mjs';
import { validateEngineeringAcceptance } from '../agent/modeling-engineering.mjs';

const argv = process.argv.slice(2), options = {};
for (let i = 0; i < argv.length; i += 2) {
  if (!['--context', '--objective', '--draft', '--out', '--mode', '--seed-project', '--inject-stage-gap'].includes(argv[i]) || !argv[i + 1]) throw new Error('Use --context FILE or --objective TEXT, optionally --draft FILE, --out NEW_DIRECTORY, --mode planning|production|acceptance, --seed-project DIRECTORY, --inject-stage-gap STAGE_ID.');
  options[argv[i].slice(2)] = argv[i + 1];
}
if (Boolean(options.context) === Boolean(options.objective)) throw new Error('Choose exactly one context file or natural-language objective.');
const mode = options.mode || 'planning';
if (!['planning', 'production', 'acceptance'].includes(mode) || mode !== 'planning' && options.draft) throw new Error('Production probes require fresh intake, not a retained draft.');
if (options['seed-project'] && mode === 'planning') throw new Error('A copied project requires production or acceptance mode.');
if (mode === 'acceptance' && !options['seed-project']) throw new Error('Acceptance requires a retained project copy.');
if (options['inject-stage-gap'] && mode !== 'acceptance') throw new Error('Stage fault injection requires an isolated acceptance copy.');
const context = options.context ? await readJson(path.resolve(options.context)) : { objective: options.objective, references: [] };
const originalHash = options.context ? await hashFile(path.resolve(options.context)) : null;
const draft = options.draft ? await readJson(path.resolve(options.draft)) : null;
const root = options.out ? path.resolve(options.out) : await fs.mkdtemp(path.join(os.tmpdir(), 'engineering-intake-live-'));
if (options.out) await fs.mkdir(root, { recursive: false });
const project = path.join(root, 'project'), output = path.join(root, 'run');
if (!options['seed-project']) await fs.mkdir(project);
await fs.mkdir(output);
if (options['seed-project']) {
  const source = path.resolve(options['seed-project']);
  if (project.startsWith(source + path.sep)) throw new Error('Seed project cannot contain the probe output.');
  await fs.cp(source, project, { recursive: true, force: false, errorOnExist: true,
    filter: async file => {
      const relative = path.relative(source, file);
      if (['Intermediate', 'DerivedDataCache', 'Saved', '.git', '.codex'].includes(relative.split(path.sep)[0])) return false;
      if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('Seed project cannot contain links or junctions.');
      return true;
  } });
}
const retainedContext = mode === 'acceptance' ? await readJson(path.join(project, 'plan/production-context.json')) : null;
if (mode === 'acceptance' && !retainedContext?.taskId) throw new Error('Acceptance requires the retained production identity.');
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
const iterationDeliveries = [];
let injectedEvidence;
let retainedDraftUsed = false;
console.log(JSON.stringify({ event: 'started', mode, root, sourceTaskId: context.taskId, retainedDraft: Boolean(draft) }));
const pipelineOptions = { project, output, signal: abort.signal, invocation: codexInvocation([]),
  job: { taskId: `engineering-probe-${id}`, workspaceId: id, runId: 'probe', objective: context.objective,
    referenceFiles: context.references || [], qualityCriteria: context.qualityCriteria || [], deadlineAt: new Date(started + 45 * 60000).toISOString() },
  evaluate: async ({ name }) => {
    if (name === 'modeling-plan' && draft && !retainedDraftUsed) { retainedDraftUsed = true; return draft; }
    return undefined;
  },
  probe: async () => { throw stop; },
  step: async (name, command, args, timeoutMs, cwd, accepts, extra = {}) => {
    if (mode === 'acceptance' && name.startsWith('production-orchestrator')) {
      if (options['inject-stage-gap']) {
        const file = await localPath(project, `stages/${options['inject-stage-gap']}/evidence.json`, { existing: true });
        if (!injectedEvidence) {
          injectedEvidence = await fs.readFile(file);
          await atomicJson(file, { protocol: 1, stageId: options['inject-stage-gap'], status: 'GAP',
            checks: [{ id: 'probe-injected-missing-proof', status: 'GAP', evidence: [] }],
            note: 'Intentional host-probe fault injection; the next call restores the original real evidence.' });
        } else await fs.writeFile(file, injectedEvidence);
      }
      return { exitCode: 0, stdout: '', stderr: '', stopConfirmed: true };
    }
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
  if (mode === 'acceptance') {
    process.env.MODELING_ROUTING_ENABLED = '0';
    process.env.CODEX_MAX_ATTEMPTS = options['inject-stage-gap'] ? '3' : '1';
    process.env.CODEX_RETRY_DELAY_MS = '1';
    const engineering = await readJson(path.join(project, 'plan/engineering-plan.json'));
    await validateEngineeringAcceptance(engineering, await readJson(path.join(project, 'acceptance/acceptance-report.json')), project);
    delivered = await runProductionHarness({ ...pipelineOptions, job: { ...retainedContext, referenceFiles: [] }, unreal: process.env.UNREAL_CMD,
      onIterationReview: async ({ record }) => { if (record.kind === 'iteration-delivery') iterationDeliveries.push({ iteration: record.iteration, score: record.score, status: record.status }); } });
    await pipelineOptions.step('retained-package-playtest', delivered.files.packageFile,
      ['-unattended', '-nullrhi', '-ExecCmds=Quit'], 60000, path.dirname(delivered.files.packageFile));
  } else if (mode === 'production') delivered = await runProductionHarness({ ...pipelineOptions, unreal: process.env.UNREAL_CMD });
  else await createModelingPipeline(pipelineOptions).prepare();
} catch (caught) { if (caught !== stop) error = caught; }
const plan = await readJson(path.join(project, 'plan/modeling-specs.json'));
const engineering = await readJson(path.join(project, 'plan/engineering-plan.json'));
const report = { mode, sourceTaskId: context.taskId || null, seedProject: options['seed-project'] || null, root, durationMs: Date.now() - started, calls,
  passed: !error && Boolean(plan) && Boolean(engineering) && (mode === 'planning' || Boolean(delivered)) &&
    (mode !== 'acceptance' || delivered?.qualityAccepted !== false) &&
    (!options['inject-stage-gap'] || iterationDeliveries.length === 2 && iterationDeliveries[0].status === 'DELIVERED_WITH_GAPS' && iterationDeliveries[1].status === 'ACCEPTED'),
  injectedStageGap: options['inject-stage-gap'] || null, iterationDeliveries,
  delivered: delivered?.files,
  sourceUnchanged: !options.context || originalHash === await hashFile(path.resolve(options.context)),
  assetCount: plan?.assets?.length, traversalAssets: plan?.assets?.filter(asset => asset.contract?.traversal).map(asset => asset.assetId),
  requirements: engineering?.requirements?.length, error: error?.message, kind: error?.kind, lastFailure: error?.lastFailure };
await atomicJson(path.join(root, 'probe-report.json'), report);
console.log(JSON.stringify(report));
process.exitCode = report.passed && report.sourceUnchanged ? 0 : 1;
