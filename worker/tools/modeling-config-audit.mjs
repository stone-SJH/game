import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const digest=text=>crypto.createHash('sha256').update(text).digest('hex');

// Codex adds project trust tables on first launch. Only remove pre-registered task tables,
// and require every remaining byte (apart from terminal newlines) to match the frozen hash.
// Config contents and provider credentials are never returned or copied to audit artifacts.
export async function verifyConfigWithTaskTrust({file,sha256},projects=[]) {
  const text=await fs.readFile(file,'utf8'),actual=digest(text);
  if(actual===sha256)return {file,sha256:actual,registeredSha256:sha256,exact:true,addedTrustProjects:[]};
  const allowed=new Set(projects.map(p=>path.win32.normalize(p).toLowerCase()));
  const added=[],kept=[];let skip=false;
  for(const line of text.match(/.*(?:\r?\n|$)/g).filter(Boolean)) {
    if(/^\s*\[/.test(line)) {
      skip=false;
      const match=line.trim().match(/^\[projects\.'([^']+)'\]$/);
      if(match&&allowed.has(path.win32.normalize(match[1]).toLowerCase())) { skip=true;added.push(match[1]);continue; }
    }
    if(skip) {
      if(line.trim()&&!/^\s*trust_level\s*=\s*"trusted"\s*$/.test(line))throw new Error('Task trust block contains an unregistered setting');
    } else kept.push(line);
  }
  const reconstructed=kept.join('').trimEnd()+'\n';
  if(!added.length||digest(reconstructed)!==sha256)throw new Error(`Frozen configuration changed beyond registered task trust: ${file}`);
  return {file,sha256:actual,registeredSha256:sha256,exact:false,reconstructedSha256:digest(reconstructed),addedTrustProjects:added};
}
