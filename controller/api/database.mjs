import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export async function transaction(db, action) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function migrate(db) {
  const directory = fileURLToPath(new URL('../deploy/migrations/', import.meta.url));
  await transaction(db, async client => {
    await client.query('SELECT pg_advisory_xact_lock(73402101)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, hash TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    for (const name of (await fs.readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
      const sql = (await fs.readFile(path.join(directory, name), 'utf8')).replaceAll('\r\n', '\n');
      const hash = crypto.createHash('sha256').update(sql).digest('hex');
      const prior = (await client.query('SELECT hash FROM schema_migrations WHERE name=$1', [name])).rows[0];
      if (prior) {
        if (prior.hash !== hash) throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      if (name === '002_phase1_accounts.sql') {
        const busy = await client.query("SELECT 1 FROM jobs WHERE status='RUNNING' LIMIT 1");
        if (busy.rowCount) throw new Error('Drain legacy running jobs before the account migration.');
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name,hash) VALUES($1,$2)', [name, hash]);
    }
  });
}

export const id = prefix => `${prefix}-${crypto.randomUUID()}`;
export const digest = value => crypto.createHash('sha256').update(value).digest('hex');
export function problem(status, message) { return Object.assign(new Error(message), { status }); }
