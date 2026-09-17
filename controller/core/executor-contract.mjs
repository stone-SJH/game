import fs from 'node:fs';
import path from 'node:path';
import { atomicJson, timestamp } from './common/fs.mjs';

// Adapter boundary for the real sandbox Codex/engine worker.
export async function executeTask({ taskDirectory, task }) {
  const output = path.join(taskDirectory, 'output');
  fs.mkdirSync(output, { recursive: true });
  atomicJson(path.join(output, 'execution-failure.json'), {
    protocol: 1,
    taskId: task.id,
    status: 'BLOCKED',
    recordedAt: timestamp(),
    reason: 'No real sandbox executor adapter has been configured for Yahaha3 yet.',
  });
}
