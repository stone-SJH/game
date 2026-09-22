import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { runCommand } from '../agent/process-runner.mjs';
import { agentEnvironment, atomicJson, localPath, hashFile, readJson, repositoryRoot } from '../agent/modeling-io.mjs';

const sourceProperty = { type: 'string', minLength: 1, maxLength: 1000 };
const schema = (properties, required) => ({ type: 'object', additionalProperties: false, properties, required });
const viewNames = ['front', 'side', 'back', 'top', 'perspective', 'other-side', 'bottom'];

export const blenderTools = [
  { name: 'blender_health', description: 'Read Blender version. Each operation uses a fresh headless scene; save and reopen .blend files explicitly.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'blender_run_python', description: 'Execute bpy Python in a fresh headless Blender process. Work only in the assigned task workspace. Import/save/export/render using bpy; save the blend to persist edits. This tool is not an OS sandbox.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['script'], properties: { script: { type: 'string', minLength: 1, maxLength: 200000 } } } },
  { name: 'blender_inspect', description: 'Open a saved task-relative blend/GLB/FBX and return measured scene data without saving it.',
    inputSchema: schema({ source: sourceProperty, objects: { type: 'array', maxItems: 100, items: sourceProperty }, collection: sourceProperty }, ['source']) },
  { name: 'blender_render_views', description: 'Render saved source with fixed QA cameras. Returns actual image content, source hash and camera metadata.',
    inputSchema: schema({ source: sourceProperty, manifest: sourceProperty, views: { type: 'array', minItems: 1, maxItems: 7, items: { type: 'string', enum: viewNames } } }, ['source']) },
  { name: 'blender_checkpoint', description: 'Copy a saved blend into an immutable host-named checkpoint after checking its expected SHA256. Reopen the returned copy to recover; never overwrite it.',
    inputSchema: schema({ source: sourceProperty, expectedHash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, stage: { type: 'string', enum: ['blockout', 'geometry', 'materials', 'runtime-prep', 'final'] } }, ['source', 'expectedHash', 'stage']) },
];

export function serveBlender({ workspace, blender, receiptFile, input = process.stdin, output = process.stdout }) {
  const pending = new Map(); let queue = Promise.resolve(), calls = [];
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const send = value => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
  const stop = () => { for (const controller of pending.values()) controller.abort(); };
  lines.on('close', stop);
  async function call(name, args, signal) {
    let commandArgs, reportFile, sourceHash, source, scriptFile;
    const definition = blenderTools.find(t => t.name === name);
    if (!definition || !args || Array.isArray(args) || Object.keys(args).some(k => !Object.hasOwn(definition.inputSchema.properties, k))) throw new Error('Invalid Blender tool arguments.');
    if (['blender_inspect', 'blender_render_views', 'blender_checkpoint'].includes(name)) {
      source = await localPath(workspace, args.source, { existing: true });
      if (!/\.(blend|glb|fbx)$/i.test(source) || !(await fs.stat(source)).isFile()) throw new Error('Invalid model source.');
      sourceHash = await hashFile(source);
      if (name === 'blender_checkpoint') {
        if (!source.endsWith('.blend') || args.expectedHash !== sourceHash || !definition.inputSchema.properties.stage.enum.includes(args.stage)) throw new Error('Checkpoint source/hash/stage mismatch.');
        const directory = `tools/modeling-checkpoints/${crypto.randomUUID()}`;
        const copy = await localPath(workspace, `${directory}/source.blend`);
        await fs.mkdir(path.dirname(copy), { recursive: true });
        await fs.copyFile(source, copy, fs.constants.COPYFILE_EXCL);
        if (await hashFile(copy) !== sourceHash) throw new Error('Source changed during checkpoint.');
        const checkpoint = { protocol: 2, source: args.source, sourceHash, stage: args.stage, file: `${directory}/source.blend` };
        await atomicJson(await localPath(workspace, `${directory}/checkpoint.json`), checkpoint);
        calls.push({ tool: name, exitCode: 0, stopConfirmed: true, ...checkpoint, finishedAt: new Date().toISOString() });
        if (receiptFile) await atomicJson(receiptFile, { protocol: 2, transport: 'mcp-stdio', calls });
        return { content: [{ type: 'text', text: JSON.stringify(checkpoint) }] };
      }
      const relative = `tools/modeling-mcp/${crypto.randomUUID()}`;
      const directory = await localPath(workspace, relative);
      await fs.mkdir(directory, { recursive: true });
      reportFile = path.join(directory, 'report.json');
      const toolScript = name === 'blender_inspect' ? 'modeling-scene-query.py' : 'modeling-render-views.py';
      commandArgs = ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', path.join(repositoryRoot, 'worker/tools', toolScript), '--', '--source', source, '--report', reportFile];
      if (name === 'blender_inspect') {
        if (args.objects && (!Array.isArray(args.objects) || args.objects.length > 100 || args.objects.some(n => typeof n !== 'string' || n.length > 160))) throw new Error('Invalid object selection.');
        if (args.collection && (typeof args.collection !== 'string' || args.collection.length > 160)) throw new Error('Invalid collection.');
        commandArgs.push('--objects', JSON.stringify(args.objects || []));
        if (args.collection) commandArgs.push('--collection', args.collection);
      } else {
        const views = args.views || viewNames.slice(0, 5);
        if (!Array.isArray(views) || !views.length || views.length > 7 || views.some(v => !viewNames.includes(v))) throw new Error('Invalid views.');
        commandArgs.push('--directory', directory, '--views', views.join(','));
        if (args.manifest) commandArgs.push('--manifest', await localPath(workspace, args.manifest, { existing: true }));
      }
    }
    else if (name === 'blender_health') commandArgs = ['--version'];
    else if (name === 'blender_run_python') {
      if (typeof args?.script !== 'string' || !args.script.trim() || args.script.length > 200000 || Object.keys(args).some(key => key !== 'script')) throw new Error('Invalid Blender script input.');
      const relative = `tools/modeling-mcp/${crypto.randomUUID()}.py`;
      const file = await localPath(workspace, relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, args.script, 'utf8');
      scriptFile = relative;
      commandArgs = ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', file];
    } else throw new Error('Unknown Blender tool.');
    const result = await runCommand(blender, commandArgs, { cwd: workspace, timeoutMs: 300000, signal, env: agentEnvironment() });
    calls.push({ tool: name, startedAt: result.startedAt, finishedAt: result.finishedAt, exitCode: result.exitCode,
      stopConfirmed: result.stopConfirmed, canceled: result.canceled, timedOut: result.timedOut, sourceHash,
      ...(scriptFile ? { scriptFile, scriptHash: await hashFile(await localPath(workspace, scriptFile)) } : {}) });
    if (receiptFile) await atomicJson(receiptFile, { protocol: 1, transport: 'mcp-stdio', calls });
    const isError = Boolean(result.error || result.exitCode !== 0 || result.timedOut || result.canceled);
    if (reportFile && !isError) {
      if (await hashFile(source) !== sourceHash) throw new Error('Inspected source changed during operation.');
      const report = await readJson(reportFile);
      if (report.sourceHash !== sourceHash) throw new Error('Inspection source hash mismatch.');
      const content = [{ type: 'text', text: JSON.stringify(report) }];
      for (const view of report.views || []) {
        const relative = path.relative(workspace, view.file).replaceAll('\\', '/');
        const file = await localPath(workspace, relative, { existing: true });
        if ((await fs.stat(file)).size > 2 * 1024 * 1024) throw new Error('Preview exceeds image budget.');
        content.push({ type: 'image', mimeType: 'image/png', data: (await fs.readFile(file)).toString('base64') });
      }
      if (JSON.stringify(content).length > 16 * 1024 * 1024) throw new Error('MCP result exceeds budget.');
      return { isError: false, content };
    }
    return { isError, content: [{ type: 'text', text: JSON.stringify({
      exitCode: result.exitCode, stopConfirmed: result.stopConfirmed, stdout: result.stdout.slice(-12000), stderr: result.stderr.slice(-4000),
      timedOut: result.timedOut, canceled: result.canceled, error: result.error,
    }) }] };
  }
  lines.on('line', line => {
    if (line.length > 1024 * 1024) { send({ id: null, error: { code: -32600, message: 'Request too large.' } }); return; }
    let request;
    try { request = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: 'Invalid JSON.' } }); return; }
    if (request.method === 'notifications/cancelled') { pending.get(request.params?.requestId)?.abort(); return; }
    if (request.id === undefined) return;
    if (request.method === 'initialize') {
      const versions = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
      send({ id: request.id, result: { protocolVersion: versions.includes(request.params?.protocolVersion) ? request.params.protocolVersion : '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'yahahagame-blender', version: '1.0.0' } } });
    } else if (request.method === 'ping') send({ id: request.id, result: {} });
    else if (request.method === 'tools/list') send({ id: request.id, result: { tools: blenderTools } });
    else if (request.method === 'tools/call') {
      const controller = new AbortController(); pending.set(request.id, controller);
      queue = queue.then(async () => {
        try { controller.signal.throwIfAborted(); send({ id: request.id, result: await call(request.params?.name, request.params?.arguments || {}, controller.signal) }); }
        catch (error) { send({ id: request.id, result: { isError: true, content: [{ type: 'text', text: String(error.message).slice(0, 1000) }] } }); }
        finally { pending.delete(request.id); }
      });
    } else send({ id: request.id, error: { code: -32601, message: 'Method not found.' } });
  });
  return { stop, finished: () => queue };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const option = name => args[args.indexOf(name) + 1];
  if (!args.includes('--workspace') || !args.includes('--blender')) throw new Error('--workspace and --blender are required.');
  const server = serveBlender({ workspace: path.resolve(option('--workspace')), blender: option('--blender'), receiptFile: args.includes('--receipt') ? option('--receipt') : undefined });
  process.on('SIGTERM', server.stop); process.on('SIGINT', server.stop);
}
