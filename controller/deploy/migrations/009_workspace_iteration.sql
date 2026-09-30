-- Additive: legacy workers, artifacts and task revisions remain readable.
ALTER TABLE workspaces ADD COLUMN maintenance JSONB;
ALTER TABLE workspaces ADD COLUMN required_capabilities JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX artifacts_verified_content ON artifacts(task_id, sha256, size_bytes) WHERE verified;
