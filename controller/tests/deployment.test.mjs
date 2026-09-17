import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../deploy/deploy-controller.sh', import.meta.url));

test('Git deployment preserves local changes and previews remote updates', { skip: process.platform === 'win32' }, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'game-git-deploy-'));
  const remote = path.join(temporary, 'remote.git');
  const upstream = path.join(temporary, 'upstream');
  const repo = path.join(temporary, 'game');
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Deployment test', GIT_AUTHOR_EMAIL: 'test@localhost',
    GIT_COMMITTER_NAME: 'Deployment test', GIT_COMMITTER_EMAIL: 'test@localhost' };
  const git = (cwd, ...args) => {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const deploy = () => spawnSync('bash', [script, '--repo', repo, '--dry-run'], { env, encoding: 'utf8' });
  const commit = (cwd, file, content) => {
    fs.writeFileSync(path.join(cwd, file), content);
    git(cwd, 'add', file);
    git(cwd, 'commit', '-m', file);
    return git(cwd, 'rev-parse', 'HEAD');
  };
  try {
    git(temporary, 'init', '--bare', '--initial-branch=main', remote);
    git(temporary, 'clone', remote, upstream);
    const initial = commit(upstream, '.gitignore', 'node_modules/\n');
    git(upstream, 'push', 'origin', 'main');
    git(temporary, 'clone', remote, repo);
    assert.equal(deploy().status, 0);

    fs.writeFileSync(path.join(repo, '.gitignore'), 'local changes\n');
    assert.equal(deploy().status, 7);
    assert.equal(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8'), 'local changes\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
    fs.writeFileSync(path.join(repo, 'untracked'), 'keep me');
    assert.equal(deploy().status, 7);
    fs.unlinkSync(path.join(repo, 'untracked'));
    fs.mkdirSync(path.join(repo, 'node_modules'));
    fs.writeFileSync(path.join(repo, 'node_modules', 'ignored'), 'runtime dependency');
    assert.equal(deploy().status, 0);

    const next = commit(upstream, 'remote-update', 'remote\n');
    git(upstream, 'push', 'origin', 'main');
    const preview = deploy();
    assert.equal(preview.status, 0, preview.stderr);
    assert.ok(preview.stderr.includes(next));
    assert.equal(git(repo, 'rev-parse', 'HEAD'), initial, 'dry-run must not advance HEAD');
    assert.equal(fs.existsSync(path.join(repo, 'remote-update')), false);
    git(repo, 'merge', '--ff-only', 'origin/main');

    const local = commit(repo, 'host-change', 'keep this deployment customization\n');
    const ahead = deploy();
    assert.equal(ahead.status, 0, ahead.stderr);
    assert.ok(ahead.stderr.includes(local), 'local commits must be selected for deployment');
    commit(upstream, 'another-update', 'remote again\n');
    git(upstream, 'push', 'origin', 'main');
    const diverged = deploy();
    assert.equal(diverged.status, 8, diverged.stderr);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), local);
    assert.equal(git(repo, 'status', '--porcelain'), '');
    git(repo, 'merge', '--no-edit', 'origin/main');
    assert.equal(deploy().status, 0, 'explicitly merged local changes remain deployable');

    git(remote, 'update-ref', '-d', 'refs/heads/main');
    assert.notEqual(deploy().status, 0, 'a deleted remote branch must not use a stale tracking ref');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
