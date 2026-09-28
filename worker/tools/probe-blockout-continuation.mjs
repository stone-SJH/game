// A copy-on-write filesystem probe: retained task paths keep their exact spelling
// for input hashes, but every write goes to an isolated overlay. No tools are run.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { atomicJson, hashFile, readJson } from '../agent/modeling-io.mjs';
import { applyBlockoutMigration } from '../agent/blockout-task-migration.mjs';
import { modelingToolHashes } from '../agent/modeling-skill-routing.mjs';
import { codexInvocation } from '../agent/production-harness.mjs';
import { createModelingPipeline } from '../agent/modeling-pipeline.mjs';

const [planFile, overlayArgument] = process.argv.slice(2);
if (!planFile || !overlayArgument) throw new Error('Usage: probe-blockout-continuation.mjs PLAN NEW_OVERLAY_DIRECTORY');
const plan = await readJson(planFile), root = path.resolve(plan.workspace), overlay = path.resolve(overlayArgument);
if (overlay === root || overlay.startsWith(root + path.sep)) throw new Error('Overlay must be outside the live task.');
await fsp.mkdir(overlay); // Require a new empty destination.
const beforeFiles = await Promise.all([...plan.preserve, ...plan.updates].map(async ({ file }) => ({ file, sha256: await hashFile(file) })));
const original = Object.fromEntries(['readFile','writeFile','stat','lstat','access','mkdir','readdir','rename','copyFile','rm','unlink','realpath','appendFile'].map(name => [name, fsp[name]]));
const exists = fs.existsSync, stream = fs.createReadStream;
const counterpart = file => {
  if (typeof file !== 'string') return file;
  const absolute = path.resolve(file);
  return absolute === root ? overlay : absolute.startsWith(root + path.sep) ? path.join(overlay, path.relative(root, absolute)) : file;
};
const read = file => { const mapped = counterpart(file); return mapped !== file && exists(mapped) ? mapped : file; };
for (const name of ['readFile','stat','lstat','access']) fsp[name] = (file, ...args) => original[name](read(file), ...args);
for (const name of ['writeFile','appendFile','mkdir','rm','unlink']) fsp[name] = (file, ...args) => original[name](counterpart(file), ...args);
fsp.copyFile = (source, destination, ...args) => original.copyFile(read(source), counterpart(destination), ...args);
fsp.rename = (source, destination, ...args) => original.rename(counterpart(source), counterpart(destination), ...args);
fsp.realpath = async (file, ...args) => {
  const resolved = await original.realpath(read(file), ...args);
  return typeof resolved === 'string' && resolved.startsWith(overlay + path.sep) ? path.join(root, path.relative(overlay, resolved)) : resolved;
};
fsp.readdir = async (file, ...args) => {
  const mapped = counterpart(file);
  if (mapped === file || !exists(mapped)) return original.readdir(file, ...args);
  const base = exists(file) ? await original.readdir(file, ...args) : [];
  const changed = await original.readdir(mapped, ...args);
  return [...new Map([...base, ...changed].map(item => [typeof item === 'string' ? item : item.name, item])).values()];
};
fs.existsSync = file => exists(read(file));
fs.createReadStream = (file, ...args) => stream(read(file), ...args);
syncBuiltinESMExports();
let outcome, boundary;
const calls = [];
try {
  await applyBlockoutMigration(plan, path.join(overlay, 'migration-audit.json'), await modelingToolHashes());
  const context = await readJson(path.join(root, 'project/plan/production-context.json'));
  const output = path.join(root, 'runs/continuation-compatibility-probe');
  await fsp.mkdir(output, { recursive: true });
  const stop = message => Object.assign(new Error(message), { executionFence: true });
  // Match the controller's normal follow-up objective while keeping its task/workspace.
  const objective = [context.objective, 'Follow-up modification request:\nContinue after verified blockout evidence recovery.',
    'Continue from the existing workspace and preserve previous changes. The latest modification takes precedence when requests conflict. Revalidate the deliverables for this modification.'].join('\n\n');
  const pipeline = createModelingPipeline({ project: path.join(root, 'project'), output, invocation: codexInvocation([]), signal: new AbortController().signal,
    job: { taskId: plan.taskId, workspaceId: plan.workspaceId, runId: 'continuation-compatibility-probe', objective },
    provider: { availability: async () => ({ enabled: false }) },
    step: async name => { calls.push(name); throw stop('Probe refuses a new external command.'); },
    evaluate: async ({ name }) => { calls.push(name); throw stop('Probe refuses a new model call.'); },
    blenderMcp: async () => { calls.push('Blender'); throw stop('Probe refuses a new Blender call.'); },
    probe: async () => { calls.push('capability'); throw stop('Probe refuses a new capability call.'); },
    check: async context => { boundary = { assetId: context.spec.assetId, attemptId: context.attemptId,
      stageArtifacts: context.stageArtifacts.length, evidence: context.artifactEvidence.length }; throw stop('Verified pending author replay; stop before technical validation.'); } });
  try { await pipeline.prepare({ iteration: 1 }); } catch (error) { if (!boundary) throw error; }
  if (calls.length || !boundary) throw new Error('Continuation unexpectedly required reauthoring.');
  outcome = { status: 'PASS', taskId: plan.taskId, targetCommit: plan.targetCommit, boundary, externalCalls: calls.length };
} finally {
  for (const [name, value] of Object.entries(original)) fsp[name] = value;
  fs.existsSync = exists; fs.createReadStream = stream; syncBuiltinESMExports();
  for (const row of beforeFiles) if (await hashFile(row.file) !== row.sha256) throw new Error(`Live task changed during isolated probe: ${row.file}`);
}
await atomicJson(path.join(overlay, 'probe-report.json'), { ...outcome, originalTaskUnchanged: true });
console.log(JSON.stringify({ ...outcome, originalTaskUnchanged: true, report: path.join(overlay, 'probe-report.json') }));
