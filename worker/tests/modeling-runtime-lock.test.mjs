import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { modelingRuntimeIdentity } from '../agent/modeling-runtime-lock.mjs';
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
