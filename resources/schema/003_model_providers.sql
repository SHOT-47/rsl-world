CREATE TABLE IF NOT EXISTS model_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  kind TEXT NOT NULL CHECK(kind IN ('local','cloud')),
  base_url TEXT NOT NULL,
  model TEXT NOT NULL CHECK(length(model) BETWEEN 1 AND 200),
  encrypted_api_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

UPDATE schema_meta SET value='3' WHERE key='schema_version';
CREATE INDEX IF NOT EXISTS idx_model_providers_updated ON model_providers(updated_at DESC);
