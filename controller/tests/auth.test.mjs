import assert from 'node:assert/strict';
import test from 'node:test';
import { auth } from '../api/auth.mjs';

test('browser and worker credentials use separate headers', () => {
  const browser = { headers: { 'x-internal-token': 'browser-secret' } };
  const worker = { headers: { 'x-worker-token': 'worker-secret' } };
  assert.equal(auth(browser, 'browser-secret'), true);
  assert.equal(auth(worker, 'worker-secret', 'x-worker-token'), true);
  assert.equal(auth(browser, 'browser-secret', 'x-worker-token'), false);
  assert.equal(auth(worker, 'worker-secret'), false);
  assert.equal(auth(worker, 'wrong-secret', 'x-worker-token'), false);
  assert.equal(auth({ headers: {} }, ''), false);
});
