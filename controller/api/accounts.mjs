import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { digest, id, problem, transaction } from './database.mjs';

const scrypt = promisify(crypto.scrypt);
export async function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt}$${hash.toString('hex')}`;
}
export async function passwordMatches(password, encoded) {
  const parts = String(encoded).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const actual = await passwordHash(password, parts[1]);
  return actual.length === encoded.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(encoded));
}

export function sessionCookie(token, secure, expired = false) {
  return `yahahagame_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${expired ? 0 : 604800}${secure ? '; Secure' : ''}`;
}
function cookieToken(req) {
  return (req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith('yahahagame_session='))?.slice(19) || '';
}
export async function sessionFor(db, req) {
  const token = cookieToken(req);
  if (!token) return null;
  const session = (await db.query(`SELECT s.*,u.username FROM user_sessions s JOIN users u USING(user_id)
    WHERE token_hash=$1 AND expires_at>now() AND last_seen_at>now()-interval '1 day' AND u.status='ACTIVE'`, [digest(token)])).rows[0];
  if (session) await db.query('UPDATE user_sessions SET last_seen_at=now() WHERE token_hash=$1', [session.token_hash]);
  return session || null;
}
async function issueSession(client, user) {
  const token = crypto.randomBytes(32).toString('hex');
  const csrfToken = crypto.randomBytes(24).toString('hex');
  await client.query("INSERT INTO user_sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '7 days')", [digest(token), user.user_id, csrfToken]);
  return { token, user: { userId: user.user_id, username: user.username }, csrfToken };
}
export async function createInvite(db, days = 7) {
  const code = crypto.randomBytes(24).toString('base64url');
  await db.query("INSERT INTO registration_invites(invite_id,code_hash,expires_at) VALUES($1,$2,now()+$3*interval '1 day')", [id('invite'), digest(code), days]);
  return code;
}

export async function authenticate(db, input, { register = false, maxUsers = 10 } = {}) {
  const username = String(input.username || '').trim().toLowerCase();
  const password = String(input.password || '');
  if (!/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(username) || password.length < 10 || password.length > 128) {
    throw problem(400, 'Use a 3-32 character username and a 10-128 character password.');
  }
  if (!register) {
    const user = (await db.query("SELECT * FROM users WHERE username=$1 AND status='ACTIVE'", [username])).rows[0];
    const valid = await passwordMatches(password, user?.password_hash || `scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`);
    if (!user || !valid) throw problem(401, 'Invalid username or password.');
    return transaction(db, async client => {
      await client.query("INSERT INTO audit_events(user_id,event_type) VALUES($1,'LOGIN')", [user.user_id]);
      return issueSession(client, user);
    });
  }
  const hash = await passwordHash(password);
  return transaction(db, async client => {
    await client.query('SELECT pg_advisory_xact_lock(73402102)');
    const count = Number((await client.query('SELECT count(*) FROM users')).rows[0].count);
    if (count >= maxUsers) throw problem(409, 'Internal test account capacity reached.');
    const invite = (await client.query('SELECT * FROM registration_invites WHERE code_hash=$1 FOR UPDATE', [digest(String(input.code || ''))])).rows[0];
    if (!invite || invite.redeemed_by || invite.revoked_at || new Date(invite.expires_at) <= new Date()) throw problem(400, 'Invalid or expired invitation.');
    if ((await client.query('SELECT 1 FROM users WHERE username=$1', [username])).rowCount) throw problem(409, 'Username unavailable.');
    const user = { user_id: id('user'), username };
    await client.query('INSERT INTO users(user_id,username,password_hash) VALUES($1,$2,$3)', [user.user_id, username, hash]);
    await client.query('UPDATE registration_invites SET redeemed_by=$1,redeemed_at=now() WHERE invite_id=$2', [user.user_id, invite.invite_id]);
    await client.query("INSERT INTO audit_events(user_id,event_type) VALUES($1,'REGISTER')", [user.user_id]);
    return issueSession(client, user);
  });
}

export async function rateLimit(db, bucket, limit = 30) {
  const row = (await db.query(`INSERT INTO auth_rate_limits(bucket,hits) VALUES($1,1)
    ON CONFLICT(bucket) DO UPDATE SET hits=CASE WHEN auth_rate_limits.window_start<now()-interval '15 minutes' THEN 1 ELSE auth_rate_limits.hits+1 END,
    window_start=CASE WHEN auth_rate_limits.window_start<now()-interval '15 minutes' THEN now() ELSE auth_rate_limits.window_start END RETURNING hits`, [digest(bucket)])).rows[0];
  if (row.hits > limit) throw problem(429, 'Too many attempts. Try again later.');
}
