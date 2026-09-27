import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { hashFile } from '../agent/modeling-io.mjs';
import { verifyConfigWithTaskTrust } from '../tools/modeling-config-audit.mjs';

test('accept only registered trust additions with exact reconstruction; redact config values',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'config-audit-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'config.toml'),base='model = "fixture-model"\n[model_providers.fixture]\nsecret = "fixture-private-value"\n';
  await fs.writeFile(file,base);const expected={file,sha256:await hashFile(file)};
  assert.equal((await verifyConfigWithTaskTrust(expected)).exact,true);
  const addition='\n[projects.\'d:\\audit\\task\\project\']\ntrust_level = "trusted"\n';
  await fs.writeFile(file,base+addition);
  const result=await verifyConfigWithTaskTrust(expected,['D:/audit/task/project']);
  assert.equal(result.exact,false);assert.equal(result.reconstructedSha256,expected.sha256);
  assert.ok(!JSON.stringify(result).includes('fixture-private-value'));
  await assert.rejects(verifyConfigWithTaskTrust(expected,[]),/changed beyond/);
  await fs.writeFile(file,base.replace('fixture-model','other-model')+addition);
  await assert.rejects(verifyConfigWithTaskTrust(expected,['D:/audit/task/project']),/changed beyond/);
  await fs.writeFile(file,base+addition+'model = "injected"\n');
  await assert.rejects(verifyConfigWithTaskTrust(expected,['D:/audit/task/project']),/unregistered setting/);
});
