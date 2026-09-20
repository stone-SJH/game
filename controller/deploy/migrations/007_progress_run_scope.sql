CREATE INDEX IF NOT EXISTS task_progress_run_iteration_idx
  ON task_events (task_id, (payload->>'runId'), (payload->'progress'->>'iteration'), event_id DESC)
  WHERE event_type = 'WORKER_PROGRESS'
    AND payload->>'runId' IS NOT NULL
    AND (payload->'progress'->>'iteration') ~ '^[0-9]+$';
