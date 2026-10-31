CREATE TABLE IF NOT EXISTS task_context_records (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  created_at TEXT NOT NULL,
  record_json TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  UNIQUE(task_id, sequence)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_context_records_task_sequence
  ON task_context_records(task_id, sequence);

CREATE TRIGGER IF NOT EXISTS task_context_records_no_update
BEFORE UPDATE ON task_context_records
BEGIN
  SELECT RAISE(ABORT, 'context ledger records are append-only');
END;

CREATE TABLE IF NOT EXISTS task_context_snapshots (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  base_version INTEGER NOT NULL CHECK (base_version >= 0 AND base_version < version),
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed','active','superseded')),
  snapshot_json TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  PRIMARY KEY(task_id, version)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_context_one_active_snapshot
  ON task_context_snapshots(task_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_context_snapshots_task_status
  ON task_context_snapshots(task_id, status, version DESC);

CREATE TRIGGER IF NOT EXISTS task_context_snapshots_content_immutable
BEFORE UPDATE OF task_id, version, base_version, created_at, snapshot_json, sha256
ON task_context_snapshots
BEGIN
  SELECT RAISE(ABORT, 'context snapshot contents are immutable');
END;

INSERT INTO schema_meta(key, value) VALUES ('schema_version', '7')
ON CONFLICT(key) DO UPDATE SET value='7';
