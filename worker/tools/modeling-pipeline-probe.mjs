// Real Blender MCP + source/export validation. Optional independent live image review.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createModelingPipeline } from '../agent/modeling-pipeline.mjs';
import { callBlenderMcp } from '../agent/modeling-capabilities.mjs';
import { createTripoProvider } from '../agent/providers/tripo.mjs';
import { codexInvocation } from '../agent/production-harness.mjs';
import { runCommand } from '../agent/process-runner.mjs';
import { atomicJson, hashFile } from '../agent/modeling-io.mjs';

const args = process.argv.slice(2);
if (args.some(arg => !['--live-review', '--live-author', '--live-evaluation', '--balance', '--cancel', '--reuse', '--generated'].includes(arg))) throw new Error('Unknown modeling probe option.');
const liveReview = args.includes('--live-review');
const liveAuthor = args.includes('--live-author');
const liveEvaluation = args.includes('--live-evaluation');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modeling-probe 中文 '));
const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
const spec = { assetId: 'red-lantern', description: 'A decorative red lantern', prompt: 'A round red lantern with brass top and bottom caps',
  requirements: ['The main body is round and red.', 'The top and bottom caps are brass colored.'],
  referenceImages: [], maxTriangles: 30000, requireRig: false, requireClosedMesh: false };
const predictions = spec.requirements.map(criterion => ({ criterion, achievable: true, evidence: 'Probe checks a bounded primitive and material workflow.' }));
const results = [];
for (const mode of ['missing-key', 'credits-fallback', ...(args.includes('--reuse') ? ['reuse'] : []), ...(args.includes('--generated') ? ['generated-cleanup'] : [])]) {
  const project = path.join(root, mode, 'project'), output = path.join(root, mode, 'run');
  await fs.mkdir(project, { recursive: true }); await fs.mkdir(output, { recursive: true });
  let originalHash;
  if (mode === 'reuse') {
    const original = results[0].result.assets[0].files.find(file => file.path.endsWith('/source.blend'));
    await fs.mkdir(path.join(project, 'art'));
    await fs.copyFile(path.join(root, 'missing-key', 'project', original.path), path.join(project, 'art/existing.blend'));
    originalHash = await hashFile(path.join(project, 'art/existing.blend'));
    await atomicJson(path.join(project, 'provenance/modeling-catalog.json'), { assets: [{ path: 'art/existing.blend', description: spec.description,
      source: 'Probe task authored source', license: 'Probe task authored', sha256: originalHash }] });
  }
  const keyFile = path.join(root, mode, 'fake-key.txt');
  const thirdParty = ['credits-fallback', 'generated-cleanup'].includes(mode);
  if (thirdParty) await fs.writeFile(keyFile, 'probe-fixture-key');
  const provider = createTripoProvider({ keyFile, fetchImpl: async (url, options) => {
    if (mode !== 'generated-cleanup') return new Response(JSON.stringify({ code: 2010, message: 'Insufficient credits' }), { status: 403 });
    if (options.method === 'POST') return new Response(JSON.stringify({ code: 0, data: { task_id: 'probe-fixture' } }));
    if (url.includes('/tasks/')) return new Response(JSON.stringify({ code: 0, data: { status: 'success', output: { model_url: 'https://cdn.tripo3d.ai/probe.glb' } } }));
    const glb = results[0].result.assets[0].files.find(file => file.path.endsWith('/model.glb'));
    return new Response(await fs.readFile(path.join(root, 'missing-key', 'project', glb.path)));
  } });
  const pipeline = createModelingPipeline({ job: { taskId: `probe-${mode}`, workspaceId: mode, runId: 'probe', objective: 'Model a decorative red lantern', modelingSpecs: [spec] },
    project, output, signal: controller.signal, provider, invocation: codexInvocation([]),
    step: async (name, command, commandArgs, timeoutMs, cwd, accepts, options = {}) => {
      const result = await runCommand(command, commandArgs, { ...options, cwd, timeoutMs, signal: controller.signal,
        stdoutFile: path.join(output, `${name}.stdout.log`), stderrFile: path.join(output, `${name}.stderr.log`) });
      if (!result.stopConfirmed) throw Object.assign(new Error('Probe process stop not confirmed.'), { stopConfirmed: false });
      if (result.exitCode !== 0 || result.timedOut || result.error) throw new Error(`Probe step failed: ${name}: ${result.stderr.slice(-2000)} ${result.stdout.slice(-2000)}`);
      return result;
    },
    evaluate: async ({ name, images, prompt }) => {
      if (name === 'modeling-evaluation' && liveEvaluation && !thirdParty) return undefined;
      if (name === 'modeling-evaluation') return {
        complexity: 'low', precision: 'Recognizable probe shape', qualityTarget: 'Two observable probe requirements', capabilityCoverage: 'Headless bpy and GLB export', unknowns: [], confidence: 0.9,
        candidates: JSON.parse(prompt.split('\n').find(line => line.startsWith('Candidates: ')).slice(12)).map(item => ({
          assetId: item.assetId, similarity: 0.95, canMeetQuality: true, editPlan: ['Adjust brass roughness'], qualityByCriterion: predictions, reason: 'Same shape and colors' })),
        direct: { canMeetQuality: true, estimatedMinutes: 40, plan: ['Author a lantern'], qualityByCriterion: predictions },
        thirdParty: { assessed: thirdParty, preferred: thirdParty, smallEditsOnly: true, editMinutes: 5, editPlan: ['Set scale'],
          qualityByCriterion: thirdParty ? predictions : [], reason: 'Exercise the configured probe route' }, rationale: 'Probe route fixture',
      };
      if (liveReview) return undefined;
      if (![4, 8].includes(images.length)) throw new Error('Expected four actual model views per supplied model.');
      for (const image of images) if ((await fs.readFile(image)).readUInt32BE(0) !== 0x89504e47) throw new Error('Invalid PNG evidence.');
      return { criteria: spec.requirements.map(criterion => ({ criterion, status: 'PASS', evidence: 'Probe fixture only; not a live semantic review' })), smallEditsOnly: true, repairInstructions: '' };
    },
    build: liveAuthor && mode === 'missing-key' ? undefined : async ({ directory, receiptFile, sourceFile }) => {
      const destination = path.join(project, directory);
      if (mode === 'reuse' || mode === 'generated-cleanup') {
        if (!sourceFile || sourceFile === 'art/existing.blend') throw new Error('Reuse must operate on a source copy.');
        await callBlenderMcp({ project, tool: 'blender_run_python', receiptFile, signal: controller.signal, input: { script: [
          'import bpy,os', `out = ${JSON.stringify(destination)}`,
          ...(mode === 'reuse' ? [`bpy.ops.wm.open_mainfile(filepath=${JSON.stringify(path.join(project, sourceFile))}, use_scripts=False)`] : [
            'bpy.ops.wm.read_factory_settings(use_empty=True)', `bpy.ops.import_scene.gltf(filepath=${JSON.stringify(path.join(project, sourceFile))})`,
          ]),
          'for mat in bpy.data.materials:\n if "Brass" in mat.name and mat.node_tree:\n  mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value=0.3',
          'bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out,"source.blend"))',
          'bpy.ops.export_scene.gltf(filepath=os.path.join(out,"model.glb"), export_format="GLB")',
        ].join('\n') } });
        await atomicJson(path.join(destination, 'build-report.json'), { smallEditsOnly: true, editsApplied: ['Adjusted brass roughness'], limitations: [] });
        return;
      }
      const script = [
        'import bpy, math, os', `out = ${JSON.stringify(destination)}`,
        'bpy.ops.object.select_all(action="SELECT")', 'bpy.ops.object.delete(use_global=False)',
        'red = bpy.data.materials.new("Red paper")', 'red.diffuse_color=(0.65,0.012,0.008,1)', 'red.use_nodes=True',
        'red.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value=(0.65,0.012,0.008,1)',
        'brass=bpy.data.materials.new("Brass")', 'brass.diffuse_color=(0.7,0.38,0.055,1)', 'brass.use_nodes=True',
        'brass.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value=(0.7,0.38,0.055,1)',
        'brass.node_tree.nodes["Principled BSDF"].inputs["Metallic"].default_value=0.65',
        'bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, radius=1)',
        'bpy.context.object.name="Red lantern body"', 'bpy.context.object.data.materials.append(red)',
        'for z in (-0.93,0.93):\n bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=0.38, depth=0.14, location=(0,0,z))\n bpy.context.object.data.materials.append(brass)',
        'bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out,"source.blend"))',
        'bpy.ops.export_scene.gltf(filepath=os.path.join(out,"model.glb"), export_format="GLB")',
      ].join('\n');
      await callBlenderMcp({ project, tool: 'blender_run_python', input: { script }, receiptFile, signal: controller.signal, timeoutMs: 90000 });
      await atomicJson(path.join(destination, 'build-report.json'), { smallEditsOnly: true, editsApplied: ['Probe geometry and materials'], limitations: ['Static probe asset'] });
    },
  });
  const result = await pipeline.prepare();
  await pipeline.verify();
  const expected = mode === 'reuse' ? 'reuse_blender' : mode === 'generated-cleanup' ? 'tripo_then_blender' : 'blender_direct';
  if (result.assets[0].route !== expected) throw new Error('Probe did not reach the expected route.');
  if (mode === 'reuse' && await hashFile(path.join(project, 'art/existing.blend')) !== originalHash) throw new Error('Reuse changed the original source.');
  results.push({ mode, passed: true, route: result.assets[0].route, originalRoute: result.assets[0].originalRoute, result });
  console.log(JSON.stringify({ mode, passed: true, liveReview }));
}
let balance = null;
if (args.includes('--balance')) balance = await createTripoProvider().balance({ signal: controller.signal });
let cancellation = null;
if (args.includes('--cancel')) {
  const project = path.join(root, 'cancel'); await fs.mkdir(project);
  const pidFile = path.join(project, 'blender.pid');
  const cancel = new AbortController();
  const running = callBlenderMcp({ project, tool: 'blender_run_python', signal: cancel.signal, timeoutMs: 30000,
    input: { script: `import os,time\nfrom pathlib import Path\nPath(${JSON.stringify(pidFile)}).write_text(str(os.getpid()))\ntime.sleep(60)` },
  }).then(() => null, error => error);
  let pid;
  const until = Date.now() + 15000;
  while (!pid && Date.now() < until) {
    try { pid = Number(await fs.readFile(pidFile, 'utf8')); } catch {}
    if (!pid) await new Promise(resolve => setTimeout(resolve, 100));
  }
  cancel.abort(new Error('Probe operator cancellation'));
  const error = await running;
  if (!pid || !error || error.stopConfirmed === false) throw new Error('Cancellation probe could not verify process shutdown.');
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch (error) { if (error.code !== 'ESRCH') throw error; }
  if (alive) throw new Error('Canceled Blender child is still running.');
  cancellation = { passed: true, blenderPid: pid, stopped: true };
}
const reportFile = path.join(root, 'probe-report.json');
await atomicJson(reportFile, { passed: true, realBlender: true, liveAuthor, liveEvaluation, liveVisualReview: liveReview, paidGenerationSubmitted: false, balance, cancellation, results });
console.log(JSON.stringify({ passed: true, reportFile, liveAuthor, liveEvaluation, liveVisualReview: liveReview, balance, cancellation }));
