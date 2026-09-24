import fs from 'node:fs/promises';
import path from 'node:path';
import { callBlenderMcp } from '../agent/modeling-capabilities.mjs';
import { repositoryRoot, readJson, atomicJson } from '../agent/modeling-io.mjs';
const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--out')throw new Error('Usage: --out <new audit directory>');
const root=path.resolve(args[1]);await fs.mkdir(root,{recursive:false});
const script=[`import sys,runpy,traceback`, `from pathlib import Path`, `sys.dont_write_bytecode=True`,
  `probe=runpy.run_path(${JSON.stringify(path.join(repositoryRoot,'worker/tests/modeling-author-helpers.py'))})`,
  `try:`, `    probe['run'](${JSON.stringify(root)},${JSON.stringify(path.join(repositoryRoot,'skills/yahaha-blender-modeling/scripts'))},${JSON.stringify(path.join(repositoryRoot,'worker/tools'))})`,
  `except Exception:`, `    Path(${JSON.stringify(path.join(root,'failure.txt'))}).write_text(traceback.format_exc(),encoding='utf-8')`, `    raise`].join('\n');
await callBlenderMcp({project:root,tool:'blender_run_python',input:{script},timeoutMs:300000,receiptFile:path.join(root,'mcp-receipt.json')});
const report=await readJson(path.join(root,'helper-report.json')),receipt=await readJson(path.join(root,'mcp-receipt.json'));
if(!report?.passed||!receipt?.calls?.some(c=>c.exitCode===0&&c.stopConfirmed))throw new Error('Helper probe lacks passing report and successful MCP receipt');
await atomicJson(path.join(root,'probe-report.json'),{passed:true,realBlenderMcp:true,cases:report.cases.length,blenderVersion:report.blenderVersion});
console.log(JSON.stringify({passed:true,cases:report.cases.length,root}));
