import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';

// Use the isolated dev-server access file; never register fixtures on production.
const access = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
if (!['127.0.0.1', 'localhost'].includes(new URL(access.url).hostname)) throw new Error('A loopback dev server is required.');
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXE || undefined, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(access.url);
  await page.getByRole('tab', { name: 'Register', exact: true }).click();
  await page.getByLabel('Username', { exact: true }).fill(`files-${Date.now()}`);
  await page.getByLabel('Password', { exact: true }).fill('reference-browser-test-password');
  await page.getByLabel('Activation code').fill(access.activationCode);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await page.getByLabel('Objective', { exact: true }).fill('Use these reference files for the scene');
  const fixtures = ['image.png', '日志.log', 'video.mp4', 'document.txt', 'binary.bin'].map((name, i) => ({
    name, mimeType: ['image/png', 'text/plain', 'video/mp4', 'text/plain', 'application/octet-stream'][i], buffer: Buffer.from(`fixture-${i}`),
  }));
  await page.locator('#create-files').setInputFiles([...fixtures, fixtures[0]]);
  assert.match(await page.locator('#create-error').innerText(), /at most 5/);
  assert.equal(await page.locator('#create-file-list li').count(), 0);
  await page.locator('#create-files').setInputFiles({ name: 'too-large.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(20 * 1024 ** 2 + 1) });
  assert.match(await page.locator('#create-error').innerText(), /at most 20 MB/);
  await page.locator('#create-files').setInputFiles(fixtures);
  assert.equal(await page.locator('#create-file-list li').count(), 5);
  await page.getByRole('button', { name: 'Remove 日志.log', exact: true }).click();
  assert.equal(await page.locator('#create-file-list li').count(), 4);
  await page.locator('#create-files').setInputFiles(fixtures[1]);
  let uploads = 0;
  await page.route('**/v1/references', async route => {
    uploads++;
    if (uploads === 2) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary upload failure' }) });
    return route.continue();
  });
  await page.getByRole('button', { name: 'Create task', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('create-error').textContent.includes('Temporary upload failure'));
  assert.equal(await page.locator('#create-file-list li').count(), 5);
  await page.getByRole('button', { name: 'Create task', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel task', exact: true }).waitFor();
  assert.equal(uploads, 6); // One successful upload is reused after the failed request.
  assert.equal(await page.locator('.task-references li').count(), 5);
  await page.reload();
  await page.getByRole('button', { name: 'Cancel task', exact: true }).waitFor();
  assert.equal(await page.locator('.task-references li').count(), 5);
  await page.getByRole('button', { name: 'Cancel task', exact: true }).click();
  await page.getByRole('button', { name: 'Continue task', exact: true }).click();
  await page.getByLabel('Modification prompt').fill('Use the new log to fix the scene');
  await page.locator('#followup-files').setInputFiles([...fixtures, fixtures[0]]);
  assert.match(await page.locator('#followup-error').innerText(), /at most 5/);
  await page.locator('#followup-files').setInputFiles(fixtures[1]);
  await page.getByRole('button', { name: 'Queue modification', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel task', exact: true }).waitFor();
  assert.equal(await page.locator('.task-references li').count(), 6);
  assert.match(await page.locator('.task-references li').last().innerText(), /Revision 2/);
  const download = page.waitForEvent('download');
  await page.locator('.task-references a').last().click();
  assert.equal((await download).suggestedFilename(), '日志.log');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByRole('button', { name: 'Cancel task', exact: true }).click();
  await page.getByRole('button', { name: 'Continue task', exact: true }).click();
  await page.getByLabel('Modification prompt').fill('Continue with existing references');
  await page.getByRole('button', { name: 'Queue modification', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel task', exact: true }).waitFor();
  assert.equal(await page.locator('.task-references li').count(), 6);
  await page.getByRole('button', { name: 'Cancel task', exact: true }).click();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await page.getByRole('button', { name: 'Log in', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('Browser reference checks passed: limits, removal, upload retry, create, reload, continuation, download and mobile layout.');
} finally { await browser.close(); }
