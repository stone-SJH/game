CREATE INDEX IF NOT EXISTS task_progress_iteration_idx
  ON task_events (task_id, (payload->'progress'->>'iteration'), event_id DESC)
  WHERE event_type = 'WORKER_PROGRESS'
    AND (payload->'progress'->>'iteration') ~ '^[0-9]+$';
