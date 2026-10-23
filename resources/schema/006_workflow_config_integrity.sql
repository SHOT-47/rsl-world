ALTER TABLE tasks ADD COLUMN workflow_config_sha256 TEXT NOT NULL DEFAULT '';
UPDATE schema_meta SET value='6' WHERE key='schema_version';
