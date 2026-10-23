CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS projects (
  root TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  rsl_version_pin TEXT NOT NULL DEFAULT '3.1.0-remediated',
  created_at TEXT NOT NULL,
  last_opened_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_root TEXT NOT NULL REFERENCES projects(root) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  prompt_redacted TEXT NOT NULL,
  prompt_sha256 TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('coding','rsl-investigation','target-api','provider-diagnostics')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','waiting_approval','succeeded','failed','cancelled','blocked','interrupted','outcome_uncertain')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  checkpoint_version INTEGER NOT NULL DEFAULT 0,
  summary TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_tasks_project_updated ON tasks(project_root, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE TABLE IF NOT EXISTS checkpoints (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  state_json TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (task_id, version)
) STRICT;
CREATE TABLE IF NOT EXISTS runtime_events (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('status','activity','approval','evidence','warning','error')),
  title TEXT NOT NULL,
  detail TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_events_task_at ON runtime_events(task_id, at DESC);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  operation_sha256 TEXT NOT NULL,
  summary_redacted TEXT NOT NULL,
  target_redacted TEXT NOT NULL,
  reason_redacted TEXT NOT NULL,
  expected_impact_redacted TEXT NOT NULL,
  rollback_info_redacted TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','denied','consumed','expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_approvals_task_status ON approvals(task_id, status);
INSERT INTO schema_meta(key, value) VALUES ('schema_version', '1') ON CONFLICT(key) DO NOTHING;
