ALTER TABLE approvals ADD COLUMN action_details_redacted TEXT;
UPDATE schema_meta SET value='4' WHERE key='schema_version';
