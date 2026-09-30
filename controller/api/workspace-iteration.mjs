import { id, problem } from './database.mjs';
import { change, event, matchingJob, invalidateArtifactCache } from './tasks.mjs';
import fs from 'node:fs/promises';

export async function prepareArtifact(db, worker, input) {
  if (!/^[a-f0-9]{64}$/.test(input.sha256 || '') || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0 ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,160}$/.test(input.name || '') || !/^artifact-[a-f0-9]{64}$/.test(input.artifactId || '')) throw problem(400, 'Invalid artifact metadata.');
  const result = await change(db, async client => {
    const job = await matchingJob(client, worker, input);
    if (job.run_finished_at || job.task_status !== 'RUNNING' || new Date(job.lease_until) <= new Date() || new Date(job.deadline_at) <= new Date()) throw problem(409, 'Artifact binding requires a current lease.');
    const existing = (await client.query('SELECT * FROM artifacts WHERE artifact_id=$1', [input.artifactId])).rows[0];
    if (existing && (existing.task_id !== input.taskId || existing.job_id !== job.job_id || existing.name !== input.name || existing.sha256 !== input.sha256 || Number(existing.size_bytes) !== input.sizeBytes)) throw problem(409, 'Artifact identity conflict.');
    const blob = existing || (await client.query('SELECT * FROM artifacts WHERE task_id=$1 AND sha256=$2 AND size_bytes=$3 AND verified=true ORDER BY created_at LIMIT 1', [input.taskId, input.sha256, input.sizeBytes])).rows[0];
    if (!blob?.verified || (await fs.stat(blob.storage_path).catch(() => null))?.size !== input.sizeBytes) return { uploadRequired: true };
    if (!existing) {
      await client.query('INSERT INTO artifacts(artifact_id,task_id,job_id,name,content_type,storage_path,sha256,size_bytes,verified) VALUES($1,$2,$3,$4,$5,$6,$7,$8,true)',
        [input.artifactId, input.taskId, job.job_id, input.name, blob.content_type, blob.storage_path, blob.sha256, blob.size_bytes]);
      await event(client, input.taskId, 'ARTIFACT_REUSED', { artifactId: input.artifactId, sourceArtifactId: blob.artifact_id, name: input.name });
    }
    return { uploadRequired: false, artifactId: input.artifactId, reused: true };
  });
  invalidateArtifactCache(input.taskId);
  return result;
}

export async function workspaceMaintenance(db, worker, input) {
  return change(db, async client => {
    const workspace = (await client.query('SELECT w.* FROM workspaces w JOIN tasks t USING(task_id) JOIN user_worker_bindings b ON b.user_id=t.user_id WHERE w.task_id=$1 AND b.worker_id=$2', [input.taskId, worker.worker_id])).rows[0];
    if (!workspace || workspace.worker_id && workspace.worker_id !== worker.worker_id) throw problem(404, 'Workspace not assigned to worker.');
    const active = (await client.query('SELECT 1 FROM worker_allocations WHERE workspace_id=$1 AND released_at IS NULL', [workspace.workspace_id])).rowCount;
    if (active) throw problem(409, 'Workspace execution has not settled.');
    const previous = workspace.maintenance;
    if (input.action === 'begin') {
      if (previous && previous.migrationId !== input.migrationId) throw problem(409, 'Another migration owns this workspace.');
      if (!/^[a-zA-Z0-9-]{1,100}$/.test(input.migrationId || '')) throw problem(400, 'Migration identity required.');
      const maintenance = previous || { migrationId: input.migrationId, token: id('maintenance'), writeEpoch: String(workspace.write_epoch), status: 'READY' };
      await client.query('UPDATE workspaces SET maintenance=$2 WHERE workspace_id=$1', [workspace.workspace_id, maintenance]);
      const revisions = (await client.query('SELECT r.run_id,r.revision_id,rev.revision_number,rev.input_hash,j.objective,j.job_id FROM task_runs r JOIN task_revisions rev USING(revision_id) JOIN jobs j ON j.run_id=r.run_id WHERE r.task_id=$1 ORDER BY rev.revision_number,r.created_at', [input.taskId])).rows;
      return { workspaceId: workspace.workspace_id, maintenance, revisions };
    }
    if (!previous || previous.migrationId !== input.migrationId || previous.token !== input.token || String(workspace.write_epoch) !== String(input.writeEpoch)) throw problem(409, 'Stale maintenance identity.');
    if (input.action === 'commit') {
      if (!/^[a-f0-9]{64}$/.test(input.planHash || '') || !/^[a-f0-9]{40}$/.test(input.workerCommit || '')) throw problem(400, 'Verified migration receipt required.');
      await client.query('UPDATE workspaces SET required_capabilities=$2,maintenance=$3 WHERE workspace_id=$1', [workspace.workspace_id, { workspaceIteration: 2 }, { ...previous, status: 'COMMITTED', planHash: input.planHash, workerCommit: input.workerCommit }]);
    } else if (input.action === 'release') {
      if (previous.status !== 'COMMITTED' || previous.planHash !== input.planHash) throw problem(409, 'Migration is not committed.');
      await client.query('UPDATE workspaces SET maintenance=NULL WHERE workspace_id=$1', [workspace.workspace_id]);
    } else if (input.action === 'abort' && previous.status === 'READY') {
      await client.query('UPDATE workspaces SET maintenance=NULL WHERE workspace_id=$1', [workspace.workspace_id]);
    } else throw problem(400, 'Invalid maintenance action.');
    await event(client, input.taskId, 'WORKSPACE_MIGRATION', { migrationId: input.migrationId, action: input.action, planHash: input.planHash });
    return { ok: true };
  });
}
