import fs from 'node:fs';
import path from 'node:path';
import { atomicJson, ensureDir, newId, readJson, timestamp } from '../core/common/fs.mjs';

const args = process.argv.slice(2);
const command = args.shift();
const inputFile = args.shift();
const rootArg = args.find(arg => arg.startsWith('--root='));
const root = rootArg ? path.resolve(rootArg.slice('--root='.length)) : path.resolve('control');

if (command !== 'create' || !inputFile) throw new Error('Usage: node controller/tools/trigger-task.mjs create <input.json> [--root=control]');
const input = readJson(path.resolve(inputFile));
const hostTaskId = newId('host-task');
const request = { protocol: 1, hostTaskId, createdAt: timestamp(), input };
ensureDir(path.join(root, 'inbox'));
atomicJson(path.join(root, 'inbox', `${hostTaskId}.json`), request);
console.log(JSON.stringify({ hostTaskId, status: 'QUEUED', controlRoot: root }, null, 2));
