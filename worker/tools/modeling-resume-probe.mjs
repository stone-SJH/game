// Deterministic author and reviewer fixtures; real Blender MCP, checkpoints, exports and gates.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createModelingPipeline } from '../agent/modeling-pipeline.mjs';
import { defaultContract } from '../agent/modeling-contract.mjs';
import { callBlenderMcp } from '../agent/modeling-capabilities.mjs';
import { codexInvocation } from '../agent/production-harness.mjs';
import { runCommand } from '../agent/process-runner.mjs';
import { atomicJson, readJson } from '../agent/modeling-io.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--out') throw new Error('Usage: --out <new audit directory>');
const root = path.resolve(args[1]);
await fs.mkdir(root, { recursive: false });
const project = path.join(root, 'project'), output = path.join(root, 'run');
await fs.mkdir(project); await fs.mkdir(output);
const spec = { assetId: 'resume-fixture', description: 'One red cube', prompt: 'One red cube', requirements: ['One red cube'], referenceImages: [],
  maxTriangles: 100, requireRig: false, requireClosedMesh: true, contract: defaultContract({ dimensions: { meters: [1,1,1], toleranceMeters: .001 } }) };
let controller = new AbortController(), paused = false, reviews = 0, authored = [];
function options() {
  return { job: { taskId: 'resume-probe', workspaceId: 'resume-probe', runId: 'probe', objective: spec.description, modelingSpecs: [spec] },
    project, output, signal: controller.signal, invocation: codexInvocation([]), provider: { availability: async () => ({ enabled: false }) },
    reportProgress: async value => {
      if (!paused && value.step?.includes('inspect blockout views')) {
        paused = true; controller.abort(new Error('Probe pause at saved blockout')); throw controller.signal.reason;
      }
    },
    evaluate: async ({ name }) => {
      if (name === 'modeling-evaluation') throw new Error('Probe exercises conservative route');
      if (++reviews < 3) return { verdict: 'PASS' };
      return { criteria: [{ criterion: 'One red cube', status: 'PASS', views: ['image-1'], evidence: 'Deterministic fixture only, not live visual review' }], smallEditsOnly: true, repairInstructions: '' };
    },
    step: async (name, command, commandArgs, timeoutMs, cwd, accepts, options = {}) => {
      if (name.startsWith('modeling-author-')) {
        const prompt = options.input, blockout = prompt.includes('Host stage: blockout.');
        const relative = prompt.match(/Exact output directory \(relative\): (.*?)\. Save/)[1];
        const directory = path.join(project, relative);
        const toml = commandArgs.find(arg => arg.startsWith('mcp_servers.yahaha_blender='));
        const mcpArgs = JSON.parse(toml.match(/args=(\[.*\]), required=/)[1]);
        const receiptFile = mcpArgs[mcpArgs.indexOf('--receipt') + 1];
        const source = blockout ? null : prompt.match(/Import\/open the supplied source copy: (.*?)\. Continue/)[1];
        const script = [
          'import bpy,json', 'from pathlib import Path', `out=Path(${JSON.stringify(directory)})`,
          ...(source ? [`bpy.ops.wm.open_mainfile(filepath=${JSON.stringify(path.join(project, source))},use_scripts=False)`] : [
            'bpy.ops.wm.read_factory_settings(use_empty=True)', 'bpy.ops.mesh.primitive_cube_add(size=1)', 'bpy.context.object.name="SM_Fixture"',
            'mat=bpy.data.materials.new("Red");mat.use_nodes=True', 'mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value=(.6,.01,.01,1)', 'bpy.context.object.data.materials.append(mat)',
          ]),
          '(out/"asset-manifest.json").write_text(json.dumps({"rootObject":"SM_Fixture","objects":[{"name":"SM_Fixture","role":"render-mesh","lod":0}]}))',
          '(out/"recipe.py").write_text(Path(__file__).read_text(encoding="utf-8"),encoding="utf-8")',
          'bpy.ops.wm.save_as_mainfile(filepath=str(out/"source.blend"))',
          ...(!blockout ? ['bpy.ops.export_scene.gltf(filepath=str(out/"model.glb"),export_format="GLB")', '(out/"build-report.json").write_text(json.dumps({"smallEditsOnly":True,"editsApplied":["Fixture final"],"limitations":[]}))'] : []),
        ].join('\n');
        await callBlenderMcp({ project, tool: 'blender_run_python', input: { script }, signal: controller.signal, timeoutMs, receiptFile });
        authored.push(blockout ? 'blockout' : 'final');
        return { exitCode: 0, stopConfirmed: true };
      }
      const result = await runCommand(command, commandArgs, { ...options, cwd, timeoutMs, signal: controller.signal,
        stdoutFile: path.join(output, name + '.stdout.log'), stderrFile: path.join(output, name + '.stderr.log') });
      if (result.exitCode || result.timedOut || result.canceled || !result.stopConfirmed || result.error) throw Object.assign(new Error('Probe step failed: ' + name), { result });
      return result;
    } };
}
await assert.rejects(createModelingPipeline(options()).prepare(), /Probe pause/);
const stateDirectory = (await fs.readdir(path.join(root, 'modeling-state'))).find(n => n !== 'tasks');
const stateFile = path.join(root, 'modeling-state', stateDirectory, 'state.json');
const before = await readJson(stateFile);
assert.equal(before.pending.phase, 'FINAL_PENDING');
controller = new AbortController();
const pipeline = createModelingPipeline(options());
const summary = await pipeline.prepare(); await pipeline.verify();
const after = await readJson(stateFile);
assert.deepEqual(authored, ['blockout', 'final']);
assert.equal(reviews, 3);
assert.deepEqual(after.attemptBudgets, before.attemptBudgets);
assert.equal(after.attempts.blender_direct, 1);
await atomicJson(path.join(root, 'resume-report.json'), { passed: true, liveAuthor: false, liveReview: false, realBlender: true,
  authored, reviews, budgetsUnchanged: true, summary });
console.log(JSON.stringify({ passed: true, reportFile: path.join(root, 'resume-report.json') }));
