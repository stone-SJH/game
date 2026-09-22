import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { killProcessTree } from './process-runner.mjs';
import { agentEnvironment, atomicJson, repositoryRoot, throwIfStopped } from './modeling-io.mjs';

export const blenderExecutable = () => process.env.BLENDER_EXE || 'D:\\Tools\\Blender\\blender-5.2.1-windows-x64\\blender.exe';
export const mcpServerFile = path.join(repositoryRoot, 'worker', 'tools', 'blender-mcp-server.mjs');

export function blenderMcpArgs(project, receiptFile, blender = blenderExecutable()) {
  // Passed as argv to Codex; JSON string escaping is compatible with these TOML basic strings.
  const args = [mcpServerFile, '--workspace', project, '--blender', blender, '--receipt', receiptFile];
  return ['-c', `mcp_servers.yahaha_blender={ command=${JSON.stringify(process.execPath)}, args=${JSON.stringify(args)}, required=true, tool_timeout_sec=330 }`];
}

export async function callBlenderMcp({ project, blender = blenderExecutable(), tool = 'blender_health', input = {}, signal = new AbortController().signal, timeoutMs = 60000, receiptFile }) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const args = [mcpServerFile, '--workspace', project, '--blender', blender];
    if (receiptFile) args.push('--receipt', receiptFile);
    const child = spawn(process.execPath, args, { cwd: project, windowsHide: true, detached: process.platform !== 'win32', env: agentEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', response, failure, stopping, stderr = '';
    const stop = error => { failure ||= error; if (!stopping && child.pid) stopping = killProcessTree(child.pid).catch(error => { failure = Object.assign(error, { stopConfirmed: false }); }); };
    const abort = () => stop(signal.reason || new Error('MCP canceled.'));
    const timer = setTimeout(() => stop(new Error('Blender MCP timed out.')), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    const send = value => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') stop(error); });
    child.stdout.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 20 * 1024 * 1024) { stop(new Error('MCP response exceeds budget.')); return; }
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let message; try { message = JSON.parse(line); } catch { stop(new Error('Invalid MCP response.')); return; }
        if (message.error) { stop(new Error('Blender MCP protocol error.')); return; }
        if (message.id === 1) { send({ method: 'notifications/initialized' }); send(tool === '__tools_list'
          ? { id: 2, method: 'tools/list' } : { id: 2, method: 'tools/call', params: { name: tool, arguments: input } }); }
        if (message.id === 2) { response = message.result; child.stdin.end(); }
      }
    });
    child.on('error', error => { failure = error; });
    child.on('close', async code => {
      clearTimeout(timer); signal.removeEventListener('abort', abort); await stopping;
      if (failure) reject(failure);
      else if (code !== 0 || !response || response.isError) reject(new Error(`Blender MCP failed: ${JSON.stringify(response || stderr).slice(0, 2000)}`));
      else resolve(response);
    });
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'worker-probe', version: '1' } } });
    if (signal.aborted) abort();
  });
}

export async function discoverModelingCapabilities({ project, output, signal, blender = blenderExecutable() }) {
  const snapshot = { protocol: 1, blenderCliAvailable: false, blenderMcpAvailable: false, blenderVersion: 'unverified',
    transport: 'mcp-stdio', tools: [], advancedModeling: 'unverified', agentModel: process.env.MODELING_AGENT_MODEL || 'inherited Codex configuration' };
  try {
    const response = await callBlenderMcp({ project, blender, signal });
    const result = JSON.parse(response.content[0].text);
    snapshot.blenderVersion = result.stdout.split(/\r?\n/)[0];
    snapshot.blenderCliAvailable = true; snapshot.blenderMcpAvailable = true;
    const listed = await callBlenderMcp({ project, blender, signal, tool: '__tools_list' });
    snapshot.tools = listed.tools.map(t => t.name);
    if (!['blender_health','blender_run_python','blender_inspect','blender_render_views','blender_checkpoint'].every(t=>snapshot.tools.includes(t))) throw new Error('Incomplete Blender MCP tool list.');
    snapshot.validation = { processStartup: 'PASS', bpyAuthoring: 'unverified', engineImport: 'unverified', complexAssets: 'unverified' };
  } catch (error) { throwIfStopped(error, signal); snapshot.blenderMcpAvailable = false; snapshot.error = 'Blender MCP health/tool discovery failed.'; }
  await fs.mkdir(output, { recursive: true });
  await atomicJson(path.join(output, 'modeling-capabilities.json'), snapshot);
  return snapshot;
}
