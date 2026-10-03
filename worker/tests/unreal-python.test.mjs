import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runUnrealPython } from '../tools/unreal-python.mjs';
import { readJson } from '../agent/modeling-io.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unreal python 空格 '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectFile = path.join(root, 'Game.uproject');
  await fs.writeFile(projectFile, '{}');
  await fs.writeFile(path.join(root, 'inspect.py'), 'import unreal\n');
  return { root, options: { projectFile, script: 'inspect.py', output: 'logs/probe', unreal: 'UnrealEditor-Cmd.exe' } };
}

function engine({ log = 'LogExit: Exiting.\n', exitCode = 0, ...overrides } = {}) {
  return async (command, args) => {
    if (log !== null) await fs.writeFile(args.find(arg => arg.startsWith('-abslog=')).slice(8), log);
    return { command, args, exitCode, timedOut: false, canceled: false, stopConfirmed: true, ...overrides };
  };
}

test('batch mode retains invocation and logs with space/unicode paths and no editor UI', async t => {
  const { root, options } = await fixture(t);
  const result = await runUnrealPython({ ...options, plugins: ['GeometryScripting'] }, async (command, args, runOptions) => {
    assert.equal(runOptions.cwd, root);
    assert.equal(args[0], options.projectFile);
    assert.ok(args.includes('-run=pythonscript'));
    assert.ok(args.includes('-NullRHI'));
    assert.ok(args.includes('-EnablePlugins=GeometryScripting'));
    assert.ok(args.includes(`-script=${path.join(root, 'inspect.py')}`));
    assert.ok(!args.some(arg => /ExecutePythonScript/i.test(arg)));
    return engine()(command, args);
  });
  assert.equal(result.passed, true);
  assert.equal((await readJson(path.join(root, 'logs/probe/result.json'))).passed, true);
  await assert.rejects(runUnrealPython(options, () => assert.fail('Must not overwrite retained logs')), { code: 'EEXIST' });
  const rendered = await runUnrealPython({ ...options, output: 'logs/rendered', rendering: true }, engine());
  assert.ok(rendered.args.includes('-AllowCommandletRendering'));
  assert.ok(!rendered.args.includes('-NullRHI'));
});

test('saved output or zero exit cannot conceal a failed Unreal command', async t => {
  const { options } = await fixture(t);
  for (const [i, failure] of [
    { exitCode: 3 }, { timedOut: true }, { canceled: true }, { stopConfirmed: false }, { error: 'spawn failed' },
    { log: null }, { log: 'Fatal error: Object is not packaged: ModeManagerInteractiveToolsContext None' },
    { log: 'LogPython: Error: Traceback' }, { log: 'LogOutputDevice: Error: Ensure condition failed: EditorModeToolsSingleton.IsValid()' },
  ].entries()) {
    const result = await runUnrealPython({ ...options, output: `logs/failure-${i}` }, engine(failure));
    assert.equal(result.passed, false, JSON.stringify(failure));
  }
});

test('batch invocation rejects escaped workspace paths and changed scripts', async t => {
  const { root, options } = await fixture(t);
  for (const invalid of [{ script: '../outside.py' }, { output: '../outside' }, { timeoutMs: NaN }, { plugins: ['Bad,Plugin'] }]) {
    await assert.rejects(runUnrealPython({ ...options, ...invalid }, () => assert.fail('Invalid request launched')));
  }
  const result = await runUnrealPython(options, async (...args) => {
    await fs.appendFile(path.join(root, 'inspect.py'), '# modified during execution');
    return engine()(...args);
  });
  assert.equal(result.passed, false);
  assert.equal(result.scriptUnchanged, false);
});
