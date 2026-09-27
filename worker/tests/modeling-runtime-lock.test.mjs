import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { modelingRuntimeIdentity, runtimeConfigFingerprint } from '../agent/modeling-runtime-lock.mjs';
import { pinToolchain } from '../agent/modeling-skill-routing.mjs';

test('runtime lock detects project model config changes without recording config contents', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'modeling-runtime-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'.codex'));
  const config=path.join(root,'.codex/config.toml');
  await fs.writeFile(config,'model = "fixture-model-a"\n# sensitive-fixture-marker');
  const invocation={command:process.execPath,args:[]}, before=await modelingRuntimeIdentity(invocation,root);
  assert.equal(JSON.stringify(before).includes('sensitive-fixture-marker'),false);
  await pinToolchain(path.join(root,'lock'),'runtime',before);
  await fs.writeFile(config,'model = "fixture-model-b"');
  const after=await modelingRuntimeIdentity(invocation,root);
  await assert.rejects(pinToolchain(path.join(root,'lock'),'runtime',after),/toolchain changed/);
});

test('automatic trust registration preserves the lock; model, trust revocation and other settings do not', () => {
  const project = path.resolve(os.tmpdir(), 'runtime-trust-project');
  const base = 'model = "fixture-model"\nmodel_reasoning_effort = "medium"\n';
  const registration = `\n[projects.'${project}']\ntrust_level = "trusted"\n`;
  const before = runtimeConfigFingerprint(base, project);
  assert.equal(runtimeConfigFingerprint(base + registration, project), before);
  assert.equal(runtimeConfigFingerprint(base + registration + '\n[features]\nshell_tool = false\n', project),
    runtimeConfigFingerprint(base + '\n[features]\nshell_tool = false\n', project));
  for (const changed of [
    (base + registration).replace('fixture-model', 'other-model'),
    (base + registration).replace('"medium"', '"high"'),
    (base + registration).replace('"trusted"', '"untrusted"'),
    base + registration.replace('runtime-trust-project', 'different-project'),
    base + registration + 'sandbox_mode = "read-only"\n',
  ]) assert.notEqual(runtimeConfigFingerprint(changed, project), before);
  const quoted = `\n[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`;
  assert.equal(runtimeConfigFingerprint(base + quoted, project), before);
});

test('first production trust registration permits resume but new project config still invalidates it', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-trust-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(root, 'codex');
  t.after(() => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; });
  await fs.mkdir(process.env.CODEX_HOME);
  const config = path.join(process.env.CODEX_HOME, 'config.toml'), project = path.join(root, 'project');
  await fs.mkdir(project);
  await fs.writeFile(config, 'model = "fixture"\n');
  const invocation = { command: process.execPath, args: [] }, lock = path.join(root, 'lock');
  await pinToolchain(lock, 'runtime', await modelingRuntimeIdentity(invocation, project));
  await fs.appendFile(config, `\n[projects.'${project}']\ntrust_level = "trusted"\n`);
  await pinToolchain(lock, 'runtime', await modelingRuntimeIdentity(invocation, project));
  await fs.mkdir(path.join(project, '.codex'));
  await assert.rejects(pinToolchain(lock, 'runtime', await modelingRuntimeIdentity(invocation, project)), /toolchain changed/);
  await fs.writeFile(path.join(project, '.codex/config.toml'), 'model = "new-project-model"');
  await assert.rejects(pinToolchain(lock, 'runtime', await modelingRuntimeIdentity(invocation, project)), /toolchain changed/);
});
