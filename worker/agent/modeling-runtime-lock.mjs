import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { hashFile } from './modeling-io.mjs';
import { createRequire } from 'node:module';

// Hash configuration rather than recording its contents. Never include auth.json or credentials.
export async function modelingRuntimeIdentity(invocation = {}, project) {
  const files = new Set(), missing = [];
  let configuredModel = null, configuredReasoning = null;
  async function add(file) {
    try { if ((await fs.stat(file)).isFile()) files.add(await fs.realpath(file)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; missing.push(file); }
  }
  const configFile = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
  await add(configFile);
  try {
    const text = await fs.readFile(configFile, 'utf8');
    // Only the global model identifier is reportable; never serialize config text/provider settings.
    configuredModel = text.split(/^\s*\[/m)[0].match(/^\s*model\s*=\s*"([a-zA-Z0-9_.:-]{1,100})"\s*$/m)?.[1] || null;
    configuredReasoning = text.split(/^\s*\[/m)[0].match(/^\s*model_reasoning_effort\s*=\s*"(minimal|low|medium|high|xhigh|max|ultra)"\s*$/m)?.[1] || null;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await add(path.join(project, '.codex', 'config.toml'));
  let command = invocation.command;
  if (command && !path.isAbsolute(command)) {
    for (const directory of (process.env.PATH || '').split(path.delimiter)) {
      const candidate = path.join(directory.replace(/^"|"$/g, ''), command);
      try { if ((await fs.stat(candidate)).isFile()) { command = candidate; break; } } catch {}
    }
  }
  if (command) await add(command);
  const entry = invocation.args?.find(arg => path.isAbsolute(arg) && /\.[cm]?js$/i.test(arg));
  let cliVersion = null;
  if (entry) {
    await add(entry);
    const packageFile = path.resolve(path.dirname(entry), '..', 'package.json');
    try {
      const metadata = JSON.parse(await fs.readFile(packageFile, 'utf8'));
      if (metadata.name === '@openai/codex') {
        cliVersion = metadata.version; await add(packageFile);
        // Pin optional native package metadata and binaries selected by this platform.
        const require = createRequire(entry);
        for (const name of Object.keys(metadata.optionalDependencies || {})) {
          if (!name.includes(`${process.platform}-${process.arch}`)) continue;
          try {
            const native = require.resolve(`${name}/package.json`); await add(native);
            async function binaries(directory) {
              for (const item of await fs.readdir(directory, { withFileTypes: true })) {
                const file = path.join(directory, item.name);
                if (item.isDirectory()) await binaries(file);
                else if (/^(codex(?:\.exe)?|package\.json)$/.test(item.name)) await add(file);
              }
            }
            await binaries(path.dirname(native));
          } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { version: 1, cliVersion, configuredModel, configuredReasoning, modelOverride: process.env.MODELING_AGENT_MODEL || null,
    files: await Promise.all([...files].sort().map(async file => ({ file, sha256: await hashFile(file) }))), missing: missing.sort() };
}
