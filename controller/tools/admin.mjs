import crypto from 'node:crypto';
import pg from 'pg';
import { migrate, digest, problem } from '../api/database.mjs';
import { createInvite } from '../api/accounts.mjs';
import { change } from '../api/tasks.mjs';

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const [command, argument, workerId] = process.argv.slice(2);
try {
  if (command === 'migrate') { await migrate(db); console.log('Migrations applied.'); }
  else if (command === 'invite') {
    const count = Number(argument || 1);
    if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error('Invitation count must be 1-20.');
    for (let i = 0; i < count; i++) console.log(await createInvite(db));
  } else if (command === 'enroll') {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(argument || '')) throw new Error('Supply a worker ID.');
    const token = crypto.randomBytes(32).toString('hex');
    await db.query("INSERT INTO workers(worker_id,token_hash) VALUES($1,$2)", [argument, digest(token)]);
    console.log(JSON.stringify({ workerId: argument, workerToken: token }));
  } else if (command === 'bind') {
    await change(db, async client => {
      const user = (await client.query('SELECT user_id FROM users WHERE username=$1', [argument])).rows[0];
      if (!user) throw problem(404, 'Unknown username.');
      await client.query('INSERT INTO user_worker_bindings(user_id,worker_id) VALUES($1,$2)', [user.user_id, workerId]);
      await client.query("INSERT INTO audit_events(user_id,event_type,payload) VALUES($1,'WORKER_BOUND',$2)", [user.user_id, { workerId }]);
    });
    console.log('Worker bound.');
  } else throw new Error('Usage: admin.mjs migrate | invite [count] | enroll <workerId> | bind <username> <workerId>');
} finally { await db.end(); }
