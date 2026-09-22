CREATE TABLE task_references (
  reference_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id),
  task_id TEXT REFERENCES tasks(task_id),
  revision_id TEXT,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes BETWEEN 0 AND 20971520),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((task_id IS NULL) = (revision_id IS NULL)),
  FOREIGN KEY(task_id, revision_id) REFERENCES task_revisions(task_id, revision_id)
);
CREATE INDEX task_references_pending_idx ON task_references(created_at) WHERE task_id IS NULL;
