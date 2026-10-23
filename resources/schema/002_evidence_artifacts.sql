CREATE TABLE IF NOT EXISTS evidence_artifacts (
  id TEXT PRIMARY KEY,
  project_root TEXT NOT NULL REFERENCES projects(root) ON DELETE RESTRICT,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  relative_path TEXT NOT NULL,
  name TEXT NOT NULL,
  suffix TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  modified_at TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  header_hex TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_root, relative_path, sha256)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_evidence_project_created ON evidence_artifacts(project_root, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_task ON evidence_artifacts(task_id);
UPDATE schema_meta SET value='2' WHERE key='schema_version';
