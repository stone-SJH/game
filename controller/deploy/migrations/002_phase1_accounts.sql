CREATE TABLE users (
  user_id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE registration_invites (
  invite_id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  redeemed_by TEXT REFERENCES users(user_id),
  redeemed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE TABLE user_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id),
  csrf_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON user_sessions(user_id);
CREATE TABLE auth_rate_limits (
  bucket TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  window_start TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE audit_events (
  audit_id BIGSERIAL PRIMARY KEY,
  user_id TEXT REFERENCES users(user_id),
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE tasks ADD COLUMN user_id TEXT REFERENCES users(user_id);
ALTER TABLE tasks ADD COLUMN cancel_reason TEXT;
ALTER TABLE workers ADD COLUMN token_hash TEXT;
ALTER TABLE workers ADD COLUMN boot_id TEXT;
CREATE UNIQUE INDEX workers_token_idx ON workers(token_hash) WHERE token_hash IS NOT NULL;
CREATE TABLE user_worker_bindings (
  user_id TEXT PRIMARY KEY REFERENCES users(user_id),
  worker_id TEXT NOT NULL UNIQUE REFERENCES workers(worker_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE workspaces (
  workspace_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id),
  relative_root TEXT NOT NULL UNIQUE,
  worker_id TEXT REFERENCES workers(worker_id),
  write_epoch BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE task_revisions (
  revision_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  revision_number INTEGER NOT NULL,
  input JSONB NOT NULL,
  input_hash TEXT NOT NULL,
  UNIQUE(task_id, revision_number),
  UNIQUE(task_id, revision_id)
);
CREATE TABLE task_runs (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  revision_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  FOREIGN KEY(task_id, revision_id) REFERENCES task_revisions(task_id, revision_id),
  UNIQUE(task_id, run_id)
);
CREATE UNIQUE INDEX task_active_run_idx ON task_runs(task_id) WHERE finished_at IS NULL;
ALTER TABLE jobs ADD COLUMN run_id TEXT;
ALTER TABLE jobs ADD CONSTRAINT jobs_run_fk FOREIGN KEY(task_id,run_id) REFERENCES task_runs(task_id,run_id);
ALTER TABLE jobs ADD COLUMN lease_token TEXT;
ALTER TABLE jobs ADD COLUMN worker_boot_id TEXT;
CREATE TABLE worker_allocations (
  allocation_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(job_id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  worker_id TEXT NOT NULL REFERENCES workers(worker_id),
  boot_id TEXT NOT NULL,
  write_epoch BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX allocation_worker_idx ON worker_allocations(worker_id) WHERE released_at IS NULL;
CREATE UNIQUE INDEX allocation_workspace_idx ON worker_allocations(workspace_id) WHERE released_at IS NULL;
ALTER TABLE artifacts ADD COLUMN job_id TEXT REFERENCES jobs(job_id);
ALTER TABLE artifacts ADD COLUMN verified BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX tasks_user_list_idx ON tasks(user_id,created_at DESC,task_id DESC);
