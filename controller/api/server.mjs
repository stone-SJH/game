import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { authenticate, sessionFor, sessionCookie, rateLimit } from './accounts.mjs';
import { digest, problem } from './database.mjs';
import * as tasks from './tasks.mjs';
import { getPngPreview } from './image-preview.mjs';

export function createServer({ db, artifactRoot, origin, secureCookies = true, maxUsers = 10, leaseMs = 120000,
  appRoot = fileURLToPath(new URL('../../app/', import.meta.url)), maxArtifactBytes = 2 * 1024 ** 3 }) {
  function json(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(value));
  }
  async function body(req) {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2 * 1024 ** 2) throw problem(413, 'Request too large.');
      chunks.push(chunk);
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value;
    } catch { throw problem(400, 'Expected a JSON object.'); }
  }
  async function user(req, mutate = false) {
    const session = await sessionFor(db, req);
    if (!session) throw problem(401, 'Login required.');
    if (mutate && (req.headers.origin !== origin || req.headers['x-csrf-token'] !== session.csrf_token)) throw problem(403, 'Invalid origin or CSRF token.');
    return session;
  }
  async function worker(req) {
    const row = (await db.query('SELECT * FROM workers WHERE worker_id=$1 AND token_hash=$2', [req.headers['x-worker-id'] || '', digest(String(req.headers['x-worker-token'] || ''))])).rows[0];
    if (!row) throw problem(401, 'Invalid worker identity.');
    return row;
  }
  async function upload(req, res, taskId, artifactId) {
    const agent = await worker(req);
    const lease = { taskId, jobId: req.headers['x-job-id'], bootId: req.headers['x-boot-id'], leaseToken: req.headers['x-lease-token'] };
    const job = await tasks.matchingJob(db, agent, lease);
    if (job.run_finished_at) throw problem(409, 'Execution is no longer active.');
    if (job.task_status !== 'RUNNING') throw problem(409, 'Task is not accepting artifacts.');
    const name = String(req.headers['x-artifact-name'] || ''), expected = String(req.headers['x-artifact-sha256'] || '');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,160}$/.test(name) || !/^[a-f0-9]{64}$/.test(expected)) throw problem(400, 'Invalid artifact metadata.');
    const dir = path.join(artifactRoot, taskId);
    await fsp.mkdir(dir, { recursive: true });
    const temp = path.join(dir, `.upload-${crypto.randomUUID()}`), target = path.join(dir, `${artifactId}-${name}`);
    const hash = crypto.createHash('sha256'); let size = 0, published = false;
    try {
      await pipeline(req, new Transform({ transform(chunk, encoding, callback) {
        size += chunk.length;
        if (size > maxArtifactBytes) return callback(problem(413, 'Artifact too large.'));
        hash.update(chunk); callback(null, chunk);
      } }), fs.createWriteStream(temp, { flags: 'wx' }));
      const actual = hash.digest('hex');
      if (actual !== expected) throw problem(400, 'Artifact hash mismatch.');
      const result = await tasks.change(db, async client => {
        const current = await tasks.matchingJob(client, agent, lease);
        if (current.run_finished_at) throw problem(409, 'Execution is no longer active.');
        if (current.task_status !== 'RUNNING' || new Date(current.lease_until) <= new Date()) throw problem(409, 'Artifact lease is no longer active.');
        const prior = (await client.query('SELECT * FROM artifacts WHERE artifact_id=$1', [artifactId])).rows[0];
        if (prior) {
          if (prior.job_id !== job.job_id || prior.name !== name || prior.sha256 !== actual) throw problem(409, 'Artifact identity conflict.');
          return { artifactId, name, sha256: actual, sizeBytes: size };
        }
        await fsp.rename(temp, target); published = true;
        await client.query('INSERT INTO artifacts(artifact_id,task_id,job_id,name,content_type,storage_path,sha256,size_bytes,verified) VALUES($1,$2,$3,$4,$5,$6,$7,$8,true)', [artifactId, taskId, job.job_id, name, req.headers['content-type'] || 'application/octet-stream', target, actual, size]);
        await tasks.event(client, taskId, 'ARTIFACT_CREATED', { artifactId, name });
        return { artifactId, name, sha256: actual, sizeBytes: size };
      });
      tasks.invalidateArtifactCache(taskId);
      json(res, 201, result);
    } catch (error) {
      if (published) await fsp.rm(target, { force: true });
      throw error;
    } finally { await fsp.rm(temp, { force: true }); }
  }
  async function streamEvents(req, res, taskId) {
    const session = await user(req);
    await tasks.ownedTask(db, taskId, session.user_id);
    let cursor = String(req.headers['last-event-id'] || new URL(req.url, origin).searchParams.get('after') || '0');
    if (!/^\d{1,18}$/.test(cursor)) throw problem(400, 'Invalid event cursor.');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    res.write(': connected\n\n');
    let timer, closed = false;
    res.on('close', () => { closed = true; clearTimeout(timer); });
    const pump = async () => {
      try {
        if (closed) return;
        if (!await sessionFor(db, req)) return res.end();
        const events = (await db.query('SELECT event_id,event_type,created_at FROM task_events WHERE task_id=$1 AND event_id>$2 ORDER BY event_id LIMIT 200', [taskId, cursor])).rows;
        for (const row of events) { cursor = row.event_id; res.write(`id: ${cursor}\ndata: ${JSON.stringify(row)}\n\n`); }
        if (!events.length) res.write(': heartbeat\n\n');
        if (!closed) timer = setTimeout(pump, events.length ? 250 : 15000);
      } catch { res.end(); }
    };
    await pump();
  }
  async function route(req, res) {
    const url = new URL(req.url, origin);
    if (req.method === 'GET' && ['/', '/app.js', '/app.css'].includes(url.pathname)) {
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const data = await fsp.readFile(path.join(appRoot, name));
      res.writeHead(200, { 'content-type': name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.js') ? 'text/javascript' : 'text/css', 'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; img-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
      return res.end(data);
    }
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { status: 'ok', service: 'yahahagame-controller', protocol: 2 });
    if (req.method === 'POST' && ['/v1/auth/login', '/v1/auth/register'].includes(url.pathname)) {
      if (req.headers.origin !== origin || !req.headers['content-type']?.startsWith('application/json')) throw problem(403, 'Invalid request origin.');
      await rateLimit(db, `ip:${req.socket.remoteAddress}`, 100);
      const input = await body(req);
      await rateLimit(db, `account:${String(input.username || '').toLowerCase()}`, 20);
      const value = await authenticate(db, input, { register: url.pathname.endsWith('register'), maxUsers });
      res.setHeader('set-cookie', sessionCookie(value.token, secureCookies));
      return json(res, 200, { user: value.user, csrfToken: value.csrfToken });
    }
    if (req.method === 'GET' && url.pathname === '/v1/auth/me') {
      const session = await user(req);
      return json(res, 200, { user: { userId: session.user_id, username: session.username }, csrfToken: session.csrf_token });
    }
    if (req.method === 'POST' && url.pathname === '/v1/auth/logout') {
      const session = await user(req, true);
      await db.query('DELETE FROM user_sessions WHERE token_hash=$1', [session.token_hash]);
      res.setHeader('set-cookie', sessionCookie('', secureCookies, true));
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/v1/tasks') {
      const session = await user(req, req.method !== 'GET');
      if (req.method === 'POST') {
        await rateLimit(db, `tasks:${session.user_id}`, 60);
        return json(res, 201, await tasks.createTask(db, session.user_id, await body(req)));
      }
      if (req.method === 'GET') {
        let cursor = null;
        if (url.searchParams.has('cursor')) {
          try { cursor = JSON.parse(Buffer.from(url.searchParams.get('cursor'), 'base64url').toString()); } catch { throw problem(400, 'Invalid list cursor.'); }
          if (!Array.isArray(cursor) || cursor.length !== 2 || !Number.isFinite(Date.parse(cursor[0])) || typeof cursor[1] !== 'string') throw problem(400, 'Invalid list cursor.');
        }
        const rows = (await db.query(`SELECT t.task_id,t.kind,t.objective,t.status,t.worker_id,t.created_at,t.updated_at,j.progress, t.created_at::text AS cursor_time
          FROM tasks t LEFT JOIN LATERAL (SELECT progress FROM jobs WHERE jobs.task_id=t.task_id ORDER BY jobs.created_at DESC LIMIT 1) j ON true WHERE t.user_id=$1
          AND ($2::timestamptz IS NULL OR (t.created_at,t.task_id)<($2::timestamptz,$3::text)) ORDER BY t.created_at DESC,t.task_id DESC LIMIT 51`, [session.user_id, cursor?.[0] || null, cursor?.[1] || null])).rows;
        const items = rows.slice(0, 50), last = items.at(-1);
        return json(res, 200, { tasks: items.map(({ cursor_time, ...item }) => item), nextCursor: rows.length > 50 ? Buffer.from(JSON.stringify([last.cursor_time, last.task_id])).toString('base64url') : null });
      }
    }
    const task = url.pathname.match(/^\/v1\/tasks\/([a-zA-Z0-9-]+)(?:\/(cancel|events|rerun|artifacts))?$/);
    if (task) {
      if (req.method === 'GET' && task[2] === 'events') return streamEvents(req, res, task[1]);
      const session = await user(req, req.method !== 'GET');
      if (req.method === 'GET' && task[2] === 'artifacts') return json(res, 200, await tasks.artifactView(db, task[1], session.user_id, { cursor: url.searchParams.get('cursor'), limit: url.searchParams.get('limit') }));
      if (req.method === 'GET' && !task[2]) return json(res, 200, await tasks.taskView(db, task[1], session.user_id));
      if (req.method === 'POST' && task[2] === 'cancel') {
        const value = await tasks.cancelTask(db, task[1], session.user_id);
        return json(res, value.status === 'CANCELING' ? 202 : 200, value);
      }
      if (req.method === 'POST' && task[2] === 'rerun') return json(res, 202, await tasks.rerunTask(db, task[1], session.user_id, await body(req)));
    }
    const artifact = url.pathname.match(/^\/artifacts\/([a-zA-Z0-9-]{1,100})$/);
    if (req.method === 'GET' && artifact) {
      const session = await user(req);
      const row = (await db.query('SELECT a.* FROM artifacts a JOIN tasks t USING(task_id) WHERE a.artifact_id=$1 AND t.user_id=$2 AND a.verified=true', [artifact[1], session.user_id])).rows[0];
      if (!row) throw problem(404, 'Artifact not found.');
      const sourceStat = await fsp.stat(row.storage_path).catch(() => null);
      if (!sourceStat) throw problem(404, 'Artifact file missing.');
      const preview = url.searchParams.get('preview') === '1';
      let storagePath = row.storage_path, contentType = row.content_type;
      if (preview && row.content_type === 'image/png') {
        const generated = await getPngPreview({ sourcePath: row.storage_path, cacheRoot: path.join(artifactRoot, '.previews'), artifactId: row.artifact_id });
        if (!generated) throw problem(415, 'Preview is unavailable for this image.');
        storagePath = generated; contentType = 'image/png';
      }
      const stat = storagePath === row.storage_path ? sourceStat : await fsp.stat(storagePath).catch(() => null);
      if (!stat) throw problem(404, 'Artifact file missing.');
      const inline = ['image/png', 'image/jpeg', 'image/webp', 'video/mp4'].includes(contentType);
      const etag = `"${row.sha256}-${preview ? 'preview' : 'original'}"`;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag, 'cache-control': 'private, max-age=31536000, immutable' }); return res.end(); }
      res.writeHead(200, { 'content-type': contentType, 'content-length': stat.size, etag, 'last-modified': new Date(row.created_at).toUTCString(), 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff',
        'content-security-policy': "sandbox; default-src 'none'", 'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${row.name}"` });
      return pipeline(fs.createReadStream(storagePath), res);
    }
    const uploadMatch = url.pathname.match(/^\/v1\/worker\/artifacts\/([a-zA-Z0-9-]{1,100})\/([a-zA-Z0-9-]{1,100})$/);
    if (req.method === 'POST' && uploadMatch) return upload(req, res, uploadMatch[1], uploadMatch[2]);
    if (req.method === 'GET' && url.pathname === '/v1/worker/status') {
      const agent = await worker(req);
      return json(res, 200, await tasks.workerStatus(db, agent));
    }
    if (req.method === 'POST' && url.pathname.startsWith('/v1/worker/')) {
      const agent = await worker(req), input = await body(req);
      if (input.workerId && input.workerId !== agent.worker_id) throw problem(403, 'Worker identity mismatch.');
      const handlers = { register: () => tasks.registerWorker(db, agent, input), poll: () => tasks.pollWorker(db, agent, input, leaseMs),
        heartbeat: () => tasks.heartbeat(db, agent, input, leaseMs), 'step-result': () => tasks.stepResult(db, agent, input) };
      const handler = handlers[url.pathname.slice('/v1/worker/'.length)];
      if (handler) return json(res, 200, await handler());
    }
    throw problem(404, 'Not found.');
  }
  const server = http.createServer((req, res) => route(req, res).catch(error => {
    if (!error.status) console.error(error);
    if (!res.headersSent && !res.destroyed) json(res, error.status || 500, { error: error.status ? error.message : 'Internal server error.' });
    else res.destroy();
  }));
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await tasks.reconcile(db); } catch (error) { console.error('reconcile:', error.message); } finally { busy = false; }
  }, 2000);
  timer.unref(); server.on('close', () => clearInterval(timer));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 8080), bind = process.env.BIND || '127.0.0.1';
  const origin = process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${port}`, url = new URL(origin);
  const localDev = process.env.ALLOW_INSECURE_LOCALHOST === 'true' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && ['127.0.0.1', '::1'].includes(bind);
  const insecureHttp = process.env.ALLOW_INSECURE_HTTP === 'true' && url.protocol === 'http:';
  if (url.origin !== origin || (url.protocol !== 'https:' && !localDev && !insecureHttp)) throw new Error('Set PUBLIC_ORIGIN to trusted HTTPS, or explicitly enable an approved HTTP test origin.');
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const schema = await db.query("SELECT 1 FROM schema_migrations WHERE name='006_progress_events.sql'");
  if (!schema.rowCount) throw new Error('Run npm run migrate before starting the API.');
  const maxUsers = Number(process.env.MAX_USERS || 10);
  if (!Number.isInteger(maxUsers) || maxUsers < 1) throw new Error('MAX_USERS must be a positive integer.');
  const server = createServer({ db, origin, secureCookies: url.protocol === 'https:', appRoot: process.env.APP_ROOT || undefined,
    artifactRoot: path.resolve(process.env.ARTIFACT_ROOT || '/var/lib/yahahagame-controller/artifacts'), maxUsers });
  server.listen(port, bind, () => console.log(`yahahagame-controller listening on ${origin}`));
  process.on('SIGTERM', () => server.close(async () => { await db.end(); process.exit(0); }));
}
