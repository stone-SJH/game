import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashValue } from './modeling-io.mjs';

// Read only the explicitly selected global router. Never fall back to another
// host with this router's credential, and never record auth.json or key hashes.
export async function imageGenerationSettings(env = process.env) {
  const directory = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  let config = '';
  try { config = await fs.readFile(path.join(directory, 'config.toml'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const top = config.split(/^\s*\[/m)[0];
  const provider = top.match(/^\s*model_provider\s*=\s*"([a-zA-Z0-9_-]+)"\s*$/m)?.[1];
  let section = '', active = false;
  for (const line of config.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) active = new RegExp('^\\s*\\[model_providers\\.(?:"' + provider + '"|' + provider + ')\\]\\s*$').test(line);
    else if (active) section += line + '\n';
  }
  const configuredBase = section.match(/^\s*base_url\s*=\s*"([^"\r\n]+)"\s*$/m)?.[1];
  const base = env.MODELING_IMAGE_BASE_URL || configuredBase;
  const timeoutMs = Number(env.MODELING_IMAGE_TIMEOUT_MS ?? 1200000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) throw new Error('MODELING_IMAGE_TIMEOUT_MS must be 1..3600000.');
  const maxImageGenerations = Number(env.TRIPO_MAX_IMAGE_GENERATIONS_PER_ITERATION ?? 8);
  if (!Number.isSafeInteger(maxImageGenerations) || maxImageGenerations < 0 || maxImageGenerations > 30) throw new Error('TRIPO_MAX_IMAGE_GENERATIONS_PER_ITERATION must be 0..30.');
  let endpoint = null;
  if (base) {
    const parsed = new URL(base);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Invalid image router base URL.');
    endpoint = parsed.href.replace(/\/+$/, '').replace(/\/images\/generations$/, '') + '/images/generations';
  }
  return { endpoint, authFile: path.join(directory, 'auth.json'), useCodexAuth: Boolean(configuredBase && (!env.MODELING_IMAGE_BASE_URL ||
      new URL(env.MODELING_IMAGE_BASE_URL).href.replace(/\/+$/, '') === new URL(configuredBase).href.replace(/\/+$/, ''))),
    keyFile: env.MODELING_IMAGE_API_KEY_FILE || null, envKey: env.MODELING_IMAGE_API_KEY || null,
    identity: { provider: 'local-router', endpointHash: endpoint ? hashValue(endpoint) : null,
      model: 'gpt-image-2', quality: 'high', size: '2048x2048', format: 'png',
      timeoutMs, attemptsPerIteration: 2, maxImageGenerations } };
}

export async function imageGenerationCredential(settings) {
  let key = settings.envKey;
  if (settings.keyFile) {
    const stat = await fs.stat(settings.keyFile);
    if (stat.size > 4096 || !stat.isFile()) return null;
    key = await fs.readFile(settings.keyFile, 'utf8');
  } else if (!key && settings.useCodexAuth) {
    try { key = JSON.parse(await fs.readFile(settings.authFile, 'utf8')).OPENAI_API_KEY; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  key = typeof key === 'string' ? key.replace(/^\uFEFF/, '').trim() : '';
  return key && !/[\s\x00-\x1f\x7f]/.test(key) ? key : null;
}
