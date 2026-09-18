ALTER TABLE jobs ADD COLUMN objective TEXT;
UPDATE jobs j SET objective = t.objective FROM tasks t WHERE t.task_id = j.task_id AND j.objective IS NULL;
