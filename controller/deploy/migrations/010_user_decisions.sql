-- A settled execution can await input without retaining a worker lease.
ALTER TABLE tasks ADD COLUMN input_request JSONB;
CREATE TABLE task_input_requests (
  request_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES task_revisions(revision_id),
  run_id TEXT NOT NULL REFERENCES task_runs(run_id),
  request JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','ANSWERED','CANCELED','SUPERSEDED')),
  answer_key TEXT,
  answer_hash TEXT,
  answer JSONB,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX task_one_pending_question ON task_input_requests(task_id) WHERE status='PENDING';
