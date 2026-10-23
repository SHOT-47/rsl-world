ALTER TABLE tasks ADD COLUMN workflow_config TEXT NOT NULL DEFAULT '{}';
UPDATE schema_meta SET value='5' WHERE key='schema_version';
