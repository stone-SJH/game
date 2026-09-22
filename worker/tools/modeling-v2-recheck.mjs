// Recheck saved benchmark outputs with the current validator, without rewriting accepted artifacts.
import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, atomicJson, hashFile, repositoryRoot, agentEnvironment } from '../agent/modeling-io.mjs';
import { blenderExecutable } from '../agent/modeling-capabilities.mjs';
import { runCommand } from '../agent/process-runner.mjs';

if(process.argv.length!==4)throw new Error('Usage: node modeling-v2-recheck.mjs <benchmark-root> <new-report-directory>');
const root=path.resolve(process.argv[2]),out=path.resolve(process.argv[3]);await fs.mkdir(out);
const benchmark=await readJson(path.join(root,'benchmark-report.json'));
if(!benchmark?.results?.length)throw new Error('No completed benchmark result');
const rows=[];
for(const result of benchmark.results){
 for(const asset of result.summary?.assets||[]){
  if(!asset.spec?.contract)continue;
  const project=path.join(root,result.id,'project');
  for(const file of asset.files)if(await hashFile(path.join(project,file.path))!==file.sha256)throw new Error('Accepted artifact changed.');
  const specFile=path.join(out,result.id+'-spec.json'),report=path.join(out,result.id,'geometry-report.json');
  await atomicJson(specFile,asset.spec);await fs.mkdir(path.dirname(report),{recursive:true});
  const directory=path.dirname(path.join(project,asset.files.find(f=>f.path.endsWith('/source.blend')).path));
  const command=await runCommand(blenderExecutable(),['--background','--factory-startup','--disable-autoexec','--python-exit-code','1',
    '--python',path.join(repositoryRoot,'worker/tools/modeling-asset-check.py'),'--','--directory',directory,'--spec',specFile,'--report',report,'--workspace',project],
    {cwd:project,timeoutMs:300000,env:agentEnvironment(),stdoutFile:path.join(out,result.id+'.stdout.log'),stderrFile:path.join(out,result.id+'.stderr.log')});
  const geometry=await readJson(report);
  rows.push({id:result.id,passed:command.exitCode===0&&!!geometry?.passed,report,gaps:['source','export'].flatMap(k=>geometry?.[k]?.gates?.filter(g=>g.status==='GAP')||[])});
 }
}
const validators=await Promise.all(['modeling-asset-check.py','modeling_scene.py','modeling_quality.py','modeling_reference.py'].map(async file=>({file,sha256:await hashFile(path.join(repositoryRoot,'worker/tools',file))})));
const report={passed:rows.length>0&&rows.every(r=>r.passed),rows,validators};await atomicJson(path.join(out,'recheck.json'),report);console.log(JSON.stringify(report));
if(!report.passed)process.exitCode=1;
