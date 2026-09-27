import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProductionIterations } from '../agent/production-iterations.mjs';
import { criterionScore, iterationScore } from '../agent/iteration-quality.mjs';

test('whole iterations retain launch dependencies, score history and the best result across edits and resume', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'production-iterations-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'); await fs.mkdir(path.join(project, 'package', 'Content'), { recursive: true });
  const packageFile = path.join(project, 'package/Game.exe'), preview = path.join(project, 'preview.png');
  await fs.writeFile(packageFile, 'first executable'); await fs.writeFile(preview, 'first preview');
  await fs.writeFile(path.join(project, 'package/Content/Game.pak'), 'launch dependency');
  await fs.mkdir(path.join(project, 'package/Game/Saved/Logs'), { recursive: true });
  await fs.writeFile(path.join(project, 'package/Game/Saved/Logs/Game.log'), 'mutable runtime log');
  const options = { job: { taskId: 'task', workspaceId: 'workspace', objective: 'Game' }, project, policy: { maxIterations: 10 } };
  let ledger = await createProductionIterations(options);
  assert.equal(await ledger.reserveAttempt(), 1);
  const complete = score => ledger.complete({ deliverables: { files: { packageFile, preview } }, score, threshold: 85,
    qualityAccepted: false, issues: [], quality: { criteria: [{ status: 'GAP' }] }, modeling: null });
  const first = await complete(70);
  assert.equal(first.record.status, 'DELIVERED_WITH_GAPS');
  assert.equal(await fs.readFile(path.join(path.dirname(first.retained.files.packageFile), 'Content/Game.pak'), 'utf8'), 'launch dependency');
  assert.ok(first.retained.files.packageFile.length < packageFile.length + 40);
  await assert.rejects(fs.stat(path.join(path.dirname(first.retained.files.packageFile), 'Game/Saved/Logs/Game.log')), { code: 'ENOENT' });
  await fs.mkdir(path.join(path.dirname(first.retained.files.packageFile), 'Game/Saved/Logs'), { recursive: true });
  await fs.writeFile(path.join(path.dirname(first.retained.files.packageFile), 'Game/Saved/Logs/Game.log'), 'created by a snapshot launch');
  await ledger.best();
  await fs.writeFile(packageFile, 'worse executable'); await fs.writeFile(preview, 'worse preview');
  await complete(40);
  ledger = await createProductionIterations(options);
  assert.equal(ledger.iteration, 3); assert.equal(await ledger.reserveAttempt(), 2);
  assert.deepEqual(ledger.rounds.map(row => row.score), [70, 40]);
  const best = await ledger.best('Budget ended');
  assert.equal(best.delivery.score, 70); assert.equal(best.qualityAccepted, false);
  assert.equal(await fs.readFile(best.files.packageFile, 'utf8'), 'first executable');
  await fs.appendFile(best.files.preview, 'modified');
  await assert.rejects(ledger.best(), /Frozen modeling evidence changed/);
  await assert.rejects(createProductionIterations({ ...options, policy: { maxIterations: 100 } }), /pinned/);
});

test('score describes retained evidence coverage without relabeling gaps as acceptance', () => {
  const criteria = [{ status: 'PASS' }, { status: 'GAP' }, { status: 'PASS' }];
  assert.equal(criterionScore(criteria), 67);
  assert.equal(iterationScore({ quality: { criteria }, modeling: { assets: [{ quality: { score: 25 } }, { quality: { score: 75 } }] } }), 50);
  assert.equal(criteria[1].status, 'GAP');
});
