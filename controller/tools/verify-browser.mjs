import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createInvite } from '../api/accounts.mjs';

const directory=fileURLToPath(new URL('../.local/phase1/',import.meta.url));
const access=JSON.parse(await fs.readFile(path.join(directory,'access.json'),'utf8'));
async function renewInvitation(){
  const metadata=(await fs.readFile(path.join(directory,'postgres','postmaster.pid'),'utf8')).split(/\r?\n/);
  const db=new pg.Pool({host:'127.0.0.1',port:Number(metadata[3]),user:'postgres',password:'local-test-database',database:'postgres'});
  try{access.activationCode=await createInvite(db);await fs.writeFile(path.join(directory,'access.json'),JSON.stringify(access,null,2));}finally{await db.end();}
}
await renewInvitation();
const browser=await chromium.launch({executablePath:process.env.CHROME_EXE || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true});
try {
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const page=await context.newPage(); const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(access.url);
  await page.getByRole('tab',{name:'Register',exact:true}).click();
  await page.getByLabel('Username',{exact:true}).fill(`tester-${Date.now()}`);
  await page.getByLabel('Password',{exact:true}).fill('local-browser-test-password');
  await page.getByLabel('Activation code').fill(access.activationCode);
  await page.getByRole('button',{name:'Create account',exact:true}).click();
  await page.getByRole('button',{name:'New task',exact:true}).waitFor();
  await page.getByRole('button',{name:'New task',exact:true}).click();
  await page.getByLabel('Objective',{exact:true}).fill('Verify Windows production toolchain');
  await page.getByRole('button',{name:'Create task',exact:true}).click();
  await page.getByRole('button',{name:'Cancel task',exact:true}).waitFor();
  await page.reload();
  await page.getByRole('button',{name:'Cancel task',exact:true}).waitFor();
  await page.screenshot({path:path.join(directory,'desktop.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:path.join(directory,'mobile.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.getByRole('button',{name:'Cancel task',exact:true}).click();
  await page.locator('#detail .status').filter({hasText:'CANCELED'}).waitFor();
  await page.getByRole('button',{name:'Log out',exact:true}).click();
  await page.getByRole('button',{name:'Log in',exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  console.log('Browser checks passed: registration, task creation, reload recovery, cancel, logout, desktop/mobile layout.');
}finally{
  await browser.close();
  await renewInvitation();
}
