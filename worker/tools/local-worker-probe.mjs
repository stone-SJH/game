import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = process.env.YAHAHAGAME_WORKER_ROOT || fileURLToPath(new URL('../../runtime/', import.meta.url));
const logDir = path.join(root, 'logs');
const artifactDir = path.join(root, 'artifacts');
const workspaceDir = path.join(root, 'workspace');
const blender = process.env.BLENDER_EXE || 'D:\\Tools\\Blender\\blender-5.2.1-windows-x64\\blender.exe';
const unrealCmd = process.env.UNREAL_CMD || 'D:\\UE\\UE_5.8\\Engine\\Binaries\\Win64\\UnrealEditor-Cmd.exe';

for (const directory of [logDir, artifactDir, workspaceDir]) fs.mkdirSync(directory, { recursive: true });

function run(name, command, args, timeoutMs = 120000) {
  return new Promise(resolve => {
    const startedAt = new Date().toISOString();
    const outputFile = path.join(logDir, `${name}.log`);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = result => {
      if (settled) return;
      settled = true;
      fs.writeFileSync(outputFile, JSON.stringify(result, null, 2) + '\n', 'utf8');
      resolve(result);
    };

    const child = spawn(command, args, {
      cwd: workspaceDir,
      windowsHide: true,
      shell: false,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout?.on('data', data => { stdout += data.toString(); });
    child.stderr?.on('data', data => { stderr += data.toString(); });
    child.on('error', error => {
      clearTimeout(timer);
      finish({ name, command, args, startedAt, exitCode: null, timedOut, error: error.message, passed: false });
    });
    child.on('close', exitCode => {
      clearTimeout(timer);
      finish({
        name,
        command,
        args,
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode,
        timedOut,
        stdout,
        stderr,
        passed: !timedOut && exitCode === 0,
      });
    });
  });
}

const blenderOutput = path.join(artifactDir, 'local-worker-blender.png');
const blenderExpression = [
  "import bpy",
  "bpy.context.scene.render.engine='BLENDER_EEVEE'",
  'bpy.context.scene.render.resolution_x=256',
  'bpy.context.scene.render.resolution_y=256',
  'bpy.context.scene.render.resolution_percentage=100',
  `bpy.context.scene.render.filepath=r'${blenderOutput.replaceAll('\\', '\\\\')}'`,
  'bpy.ops.render.render(write_still=True)',
  "print('BLENDER_VERSION=' + bpy.app.version_string)",
].join('; ');

const results = [];
results.push(await run('codex-help', 'cmd.exe', ['/d', '/s', '/c', 'codex --help']));

if (fs.existsSync(blender)) {
  const blenderResult = await run('blender-render', blender, [
    '--background',
    '--factory-startup',
    '--python-expr',
    blenderExpression,
  ]);
  blenderResult.passed = blenderResult.passed && fs.existsSync(blenderOutput);
  results.push(blenderResult);
} else {
  results.push({ name: 'blender-render', command: blender, exitCode: null, passed: false, error: 'Blender executable was not found.' });
}

if (fs.existsSync(unrealCmd)) {
  const unrealResult = await run('unreal-cmd-launch', unrealCmd, [
    '-unattended',
    '-nop4',
    '-nosplash',
    '-nullrhi',
  ], 30000);
  // Without a .uproject, UE may remain in platform/SDK initialization. The
  // launch probe passes when the executable starts and emits its startup log.
  unrealResult.passed = !unrealResult.error && unrealResult.exitCode === 0 && !unrealResult.timedOut && unrealResult.stdout.includes('Using bundled DotNet SDK');
  unrealResult.launchOnly = true;
  results.push(unrealResult);
} else {
  results.push({ name: 'unreal-cmd-launch', command: unrealCmd, exitCode: null, passed: false, error: 'UnrealEditor-Cmd.exe was not found.' });
}

const report = {
  protocol: 1,
  createdAt: new Date().toISOString(),
  user: `${process.env.USERDOMAIN || ''}\\${process.env.USERNAME || ''}`,
  sessionName: process.env.SESSIONNAME || null,
  nodeVersion: process.version,
  paths: { root, blender, unrealCmd, blenderOutput },
  results,
  blenderArtifact: fs.existsSync(blenderOutput),
  passed: results.every(result => result.passed) && fs.existsSync(blenderOutput),
};

const reportFile = path.join(logDir, 'local-worker-report.json');
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.passed ? 0 : 1;
