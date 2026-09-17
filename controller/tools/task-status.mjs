import fs from 'node:fs';
import path from 'node:path';
import { readJson } from '../core/common/fs.mjs';

const hostTaskId = process.argv[2];
const rootArg = process.argv.find(arg => arg.startsWith('--root='));
const root = rootArg ? path.resolve(rootArg.slice('--root='.length)) : path.resolve('control');
if (!hostTaskId) throw new Error('Usage: node controller/tools/task-status.mjs <host-task-id> [--root=control]');
const file = path.join(root, 'public', 'tasks', `${hostTaskId}.json`);
if (!fs.existsSync(file)) { console.log(JSON.stringify({ hostTaskId, status: 'QUEUED' }, null, 2)); process.exit(2); }
console.log(JSON.stringify(readJson(file), null, 2));
