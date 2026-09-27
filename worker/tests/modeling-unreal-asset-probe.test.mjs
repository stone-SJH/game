import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomicJson, hashFile, readJson } from '../agent/modeling-io.mjs';

const probe=fileURLToPath(new URL('../tools/modeling-unreal-asset-probe.mjs',import.meta.url));

test('UE probe persists preflight failures and refuses to overwrite their evidence',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ue-probe-preflight-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const source=path.join(root,'source'),output=path.join(root,'probe');await fs.mkdir(source);
 const run=()=>spawnSync(process.execPath,[probe,source,output],{encoding:'utf8',timeout:30000});
 assert.equal(run().status,1);
 const file=path.join(output,'run/probe-result.json'),report=await readJson(file);
 assert.equal(report.passed,false);assert.match(report.error,/accepted static FBX asset/);
 assert.equal(report.inputFilesUnchanged,null);
 const before=await hashFile(file);assert.equal(run().status,1);assert.equal(await hashFile(file),before);
});

test('UE probe records invalid retained provenance before invoking Blender or Unreal',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ue-probe-provenance-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const retained=path.join(root,'retained.json'),output=path.join(root,'probe');
 await atomicJson(retained,{evidenceSource:'accepted-manifest'});
 const result=spawnSync(process.execPath,[probe,path.join(root,'source'),output,path.join(root,'traversal.json'),retained],{encoding:'utf8',timeout:30000});
 assert.equal(result.status,1);const report=await readJson(path.join(output,'run/probe-result.json'));
 assert.equal(report.passed,false);assert.match(report.error,/explicitly identify unaccepted evidence/);
 assert.ok(!result.stdout.includes('stage'));
});

test('UE probe detects changed input hashes, records failure and leaves original input intact',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ue-probe-integrity-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const source=path.join(root,'source'),output=path.join(root,'probe'),file=path.join(source,'art/model.fbx');
 await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'actual FBX bytes');
 const actual=await hashFile(file);
 await atomicJson(path.join(source,'plan/modeling-results.json'),{assets:[{assetId:'fixture',requirementsHash:'frozen',
  contract:{runtime:{engine:'unreal',profile:'fbx-static'}},files:[{path:'art/model.fbx',sha256:'0'.repeat(64)}]}]});
 const result=spawnSync(process.execPath,[probe,source,output],{encoding:'utf8',timeout:30000});
 assert.equal(result.status,1);const report=await readJson(path.join(output,'run/probe-result.json'));
 assert.equal(report.passed,false);assert.equal(report.inputFilesUnchanged,false);
 assert.match(report.error,/source changed/);assert.match(report.integrityFailure,/frozen UE probe input/);
 assert.equal(await hashFile(file),actual);assert.ok(!result.stdout.includes('stage'));
});
