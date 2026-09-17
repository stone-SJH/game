import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const STAGES = [
  'intake-and-contract', 'project-bootstrap', 'art-direction-and-asset-plan',
  'asset-production-and-import', 'level-blockout-and-traversal', 'gameplay-foundation-and-input',
  'camera-combat-ai-and-feel', 'world-materials-fx-audio-and-ui', 'integration-build-and-playtest',
  'package-and-acceptance',
];

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function filesUnder(directory) {
  const files = [], pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!['.git', 'DerivedDataCache', 'Intermediate'].includes(entry.name)) pending.push(full);
      } else if (entry.isFile()) files.push(full);
    }
  }
  return files;
}

export async function inspectProduction(project) {
  const files = await filesUnder(project);
  const projectFile = files.find(file => file.toLowerCase().endsWith('.uproject'));
  const scenePreview = files.find(file => /^scene-preview\.(png|jpe?g|webp)$/i.test(path.basename(file)));
  const packageFile = files.find(file => /\.exe$/i.test(path.basename(file)) && !/^unreal(editor|pak)/i.test(path.basename(file)) && !/[\\/]binaries[\\/]/i.test(file));
  const required = {
    workspaceManifest: path.join(project, 'workspace-manifest.json'),
    assetManifest: path.join(project, 'provenance', 'asset-manifest.json'),
    stageManifest: path.join(project, 'plan', 'stage-manifest.json'),
    playtestEvidence: path.join(project, 'acceptance', 'playtest-evidence.json'),
    acceptanceReport: path.join(project, 'acceptance', 'acceptance-report.json'),
  };
  for (const stage of STAGES) {
    required[`${stage}-report`] = path.join(project, 'stages', stage, 'stage-report.json');
    required[`${stage}-evidence`] = path.join(project, 'stages', stage, 'evidence.json');
  }
  const missing = [];
  if (!projectFile) missing.push('project (.uproject)');
  if (!scenePreview) missing.push('scene preview (scene-preview.png/jpg/webp)');
  if (!packageFile) missing.push('packaged game (.exe)');
  for (const [role, file] of Object.entries(required)) {
    try { if (!(await fs.stat(file)).isFile()) missing.push(`${role} (${path.relative(project, file)})`); } catch { missing.push(`${role} (${path.relative(project, file)})`); }
  }
  return { files: { projectFile, scenePreview, packageFile, ...required }, missing };
}

function codexCommand() {
  return process.env.CODEX_CMD || (process.platform === 'win32' ? 'codex.cmd' : 'codex');
}

function codexInvocation(args) {
  const command = codexCommand();
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command, ...args] };
  }
  return { command, args };
}

export async function runProductionHarness({ job, project, output, signal, step, unreal }) {
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(output, { recursive: true });
  const context = {
    protocol: 1,
    taskId: job.taskId,
    runId: job.runId,
    workspaceId: job.workspaceId,
    objective: job.objective,
    createdAt: new Date().toISOString(),
    workspaceRoot: project,
    stages: STAGES,
    requiredOutputs: ['.uproject', 'scene-preview.png', 'packaged-game.exe', 'workspace-manifest.json', 'provenance/asset-manifest.json', 'plan/stage-manifest.json', 'acceptance/playtest-evidence.json', 'acceptance/acceptance-report.json'],
  };
  await writeJson(path.join(project, 'plan', 'production-context.json'), context);
  await writeJson(path.join(project, 'plan', 'production-plan.json'), {
    protocol: 1, taskId: job.taskId, runId: job.runId, objective: job.objective,
    stages: STAGES.map((id, index) => ({ id, order: index + 1, status: 'PENDING', outputs: [] })),
    acceptance: context.requiredOutputs,
  });
  await writeJson(path.join(project, 'plan', 'stage-manifest.json'), {
    protocol: 1, taskId: job.taskId, runId: job.runId,
    stages: STAGES.map(id => ({ id, status: 'PENDING', attempts: 0 })),
  });

  const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
  const skillCandidates = [process.env.YAHAHA_PRODUCTION_SKILL, path.join(process.env.USERPROFILE || '', '.codex', 'skills', 'yahahagame-production', 'SKILL.md'), path.resolve(moduleRoot, '..', '..', 'skills', 'yahahagame-production', 'SKILL.md')].filter(Boolean);
  const skillPath = skillCandidates.find(candidate => candidate && requireFile(candidate));
  if (!skillPath) throw new Error('The yahahagame-production skill is not installed on the worker.');
  const maxAttempts = Number(process.env.CODEX_MAX_ATTEMPTS || 0);
  const retryDelayMs = Number(process.env.CODEX_RETRY_DELAY_MS || 10000);
  let attempt = 0;
  while (true) {
    attempt++;
    const prompt = [
      `You are the YahahaGame production worker. Read and follow this skill file and its production-contract reference before editing: ${skillPath}`,
      `This is production iteration ${attempt}; inspect all existing workspace files and repair the current attempt instead of starting over.`,
      `Task objective: ${job.objective}`,
      `Work only inside this task workspace: ${project}`,
      'Execute the complete production loop: plan, create a real Unreal project, author assets and gameplay, build/package it, launch the packaged game for a bounded playtest, render a real scene preview, and write machine-readable evidence.',
      'Do not use the Blender factory-startup cube as a final preview. Do not claim success from tool exit codes alone.',
      'Before finishing, ensure these exact deliverables exist: one .uproject, scene-preview.png (or .jpg/.webp), a packaged playable .exe, workspace-manifest.json, provenance/asset-manifest.json, plan/stage-manifest.json, stage-report.json and evidence.json for every planned stage, acceptance/playtest-evidence.json, and acceptance/acceptance-report.json with passing gameplay evidence. Keep all paths relative to the workspace.',
      'Record commands, tool versions, hashes, the default map, packaged executable, launch result, and acceptance criteria in the required reports. Leave all source and build outputs in the workspace.',
      'If the objective is truly impossible with the installed tools or constraints, write acceptance/hard-failure.json with a concrete reason and stop. Do not use that marker for transient service, network, rate-limit, or build errors that can be repaired.',
    ].join('\n');
    const sessionOutput = path.join(output, `codex-production-session-${attempt}.jsonl`);
    try {
      const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--cd', project, '-o', sessionOutput, prompt];
      const invocation = codexInvocation(args);
      const orchestration = await step(`production-orchestrator-${attempt}`, invocation.command, invocation.args, Number(process.env.CODEX_TIMEOUT_MS || 4 * 60 * 60 * 1000), project);
      if (/\b(?:HARD_FAILURE|TASK_IMPOSSIBLE)\b/i.test(`${orchestration.stdout}\n${orchestration.stderr}`)) {
        throw Object.assign(new Error('Production worker reported a hard failure.'), { hardFailure: true });
      }
      if (await isFile(path.join(project, 'acceptance', 'hard-failure.json'))) throw Object.assign(new Error('Production marked as impossible by the worker.'), { hardFailure: true });

      const deliverables = await inspectProduction(project);
      if (deliverables.missing.length) throw new Error(`Production deliverables missing: ${deliverables.missing.join(', ')}.`);
      await step(`unreal-project-validation-${attempt}`, unreal, [deliverables.files.projectFile, '-run=Help', '-unattended', '-nop4', '-nosplash', '-nullrhi'], 180000, project,
        result => !result.error && result.exitCode === 0 && !result.timedOut);
      let acceptance;
      try { acceptance = JSON.parse(await fs.readFile(deliverables.files.acceptanceReport, 'utf8')); } catch (error) { throw new Error(`Invalid acceptance report: ${error.message}`); }
      const criteria = acceptance.criteria || acceptance.acceptanceCriteria;
      if (acceptance.protocol !== 1 || !(acceptance.passed === true || acceptance.accepted === true || acceptance.status === 'PASS') || !Array.isArray(criteria) || !criteria.length || criteria.some(item => item.status !== 'PASS')) {
        throw new Error('Acceptance report does not prove a passing packaged game.');
      }
      let stageManifest;
      try { stageManifest = JSON.parse(await fs.readFile(deliverables.files.stageManifest, 'utf8')); } catch (error) { throw new Error(`Invalid stage manifest: ${error.message}`); }
      if (!Array.isArray(stageManifest.stages) || stageManifest.stages.length !== STAGES.length || stageManifest.stages.some(stage => stage.status !== 'ACCEPTED')) {
        throw new Error('Stage manifest does not show every production stage as ACCEPTED.');
      }
      for (const stage of STAGES) {
        const reportPath = deliverables.files[`${stage}-report`];
        const evidencePath = deliverables.files[`${stage}-evidence`];
        let report, evidence;
        try { report = JSON.parse(await fs.readFile(reportPath, 'utf8')); evidence = JSON.parse(await fs.readFile(evidencePath, 'utf8')); } catch (error) { throw new Error(`Invalid ${stage} handoff: ${error.message}`); }
        if (!['ACCEPTED', 'PASS'].includes(report.status) || (Array.isArray(evidence.criteria) && evidence.criteria.some(item => item.status !== 'PASS'))) {
          throw new Error(`Stage ${stage} does not contain passing evidence.`);
        }
      }
      await step(`packaged-game-playtest-${attempt}`, deliverables.files.packageFile, ['-unattended', '-nullrhi', '-ExecCmds=Quit'], 60000, project,
        result => !result.error && result.exitCode === 0 && !result.timedOut);
      return deliverables;
    } catch (error) {
      if (signal.aborted || error.stopConfirmed === false || error.hardFailure || error.result?.timedOut || error.result?.error?.includes('ENOENT')) throw error;
      if (maxAttempts > 0 && attempt >= maxAttempts) throw new Error(`Production retry budget exhausted after ${attempt} iterations: ${error.message}`);
      await delay(retryDelayMs, undefined, { signal });
    }
  }
}

async function isFile(file) {
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}

function requireFile(file) {
  try { return fsSync.statSync(file).isFile(); } catch { return false; }
}

export function artifactContentType(file) {
  const ext = path.extname(file).toLowerCase();
  return ext === '.json' ? 'application/json' : ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'application/octet-stream';
}
