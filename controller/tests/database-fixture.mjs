import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrate } from '../api/database.mjs';

export async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
export async function startDatabase(directory) {
  const root = directory || await fs.mkdtemp(path.join(os.tmpdir(), 'yahahagame-phase1-'));
  await fs.mkdir(root, { recursive: true });
  const port = await availablePort();
  const password = 'local-test-database';
  const embedded = new EmbeddedPostgres({ databaseDir: path.join(root, 'postgres'), user: 'postgres', password, port,
    persistent: true, postgresFlags: ['-h', '127.0.0.1'], initdbFlags: ['--locale=C', '--encoding=UTF8'], onLog() {}, onError() {} });
  if (!await fs.stat(path.join(root, 'postgres', 'PG_VERSION')).catch(() => null)) await embedded.initialise();
  await embedded.start();
  const db = new pg.Pool({ host: '127.0.0.1', port, user: 'postgres', password, database: 'postgres' });
  await migrate(db);
  return { db, root, close: async () => { await db.end(); await embedded.stop(); } };
}
