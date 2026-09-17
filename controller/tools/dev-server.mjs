import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startDatabase, availablePort } from '../tests/database-fixture.mjs';
import { createServer } from '../api/server.mjs';
import { createInvite } from '../api/accounts.mjs';

const directory=fileURLToPath(new URL('../.local/phase1/',import.meta.url));
const fixture=await startDatabase(directory);
const port=Number(process.env.DEV_PORT || await availablePort());
const origin=`http://127.0.0.1:${port}`;
const server=createServer({db:fixture.db,origin,secureCookies:false,artifactRoot:path.join(directory,'artifacts')});
const invite=await createInvite(fixture.db);
await fs.writeFile(path.join(directory,'access.json'),JSON.stringify({url:origin,activationCode:invite},null,2));
await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
console.log(`Local Phase 1: ${origin}; activation code in ${path.join(directory,'access.json')}`);
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(async()=>{await fixture.close();process.exit(0);}));
