CREATE INDEX IF NOT EXISTS artifacts_task_created_verified_idx
  ON artifacts (task_id, created_at DESC, artifact_id DESC) INCLUDE (size_bytes)
  WHERE verified = true;
