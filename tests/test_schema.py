from __future__ import annotations

import hashlib
import sqlite3
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = "\n".join(path.read_text(encoding="utf-8") for path in sorted((ROOT / "resources/schema").glob("*.sql")))


class SchemaContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp.name) / "workbench.sqlite"
        self.db = sqlite3.connect(self.db_path)
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript(SCHEMA)
        self.db.execute(
            "INSERT INTO projects(root, display_name, created_at, last_opened_at) VALUES(?,?,?,?)",
            ("/workspace", "workspace", "2026-10-22T00:00:00Z", "2026-10-22T00:00:00Z"),
        )
        self.db.commit()

    def tearDown(self) -> None:
        self.db.close()
        self.temp.cleanup()

    def add_task(self, task_id: str = "task-1", status: str = "blocked") -> None:
        self.db.execute(
            """INSERT INTO tasks(id, project_root, title, prompt_redacted, prompt_sha256, mode, status,
               created_at, updated_at, checkpoint_version, summary) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
            (task_id, "/workspace", "task", "safe prompt", hashlib.sha256(b"safe prompt").hexdigest(),
             "coding", status, "2026-10-22T00:00:00Z", "2026-10-22T00:00:00Z", 0, "not executed"),
        )

    def test_schema_versions_and_foreign_keys(self) -> None:
        self.assertEqual(self.db.execute("SELECT value FROM schema_meta WHERE key='schema_version'").fetchone()[0], "6")
        with self.assertRaises(sqlite3.IntegrityError):
            self.add_task(status="unsafe-status")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO tasks(id, project_root, title, prompt_redacted, prompt_sha256, mode, status, created_at, updated_at) VALUES('orphan','/no-project','x','x','x','coding','blocked','now','now')")

    def test_checkpoint_versions_are_immutable_and_integrity_checkable(self) -> None:
        self.add_task()
        payload = '{"schemaVersion":1,"status":"blocked"}'
        digest = hashlib.sha256(payload.encode()).hexdigest()
        self.db.execute("INSERT INTO checkpoints(task_id,version,created_at,state_json,sha256) VALUES(?,?,?,?,?)", ("task-1", 1, "now", payload, digest))
        self.db.commit()
        saved = self.db.execute("SELECT state_json,sha256 FROM checkpoints WHERE task_id='task-1' AND version=1").fetchone()
        self.assertEqual(hashlib.sha256(saved[0].encode()).hexdigest(), saved[1])
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO checkpoints(task_id,version,created_at,state_json,sha256) VALUES(?,?,?,?,?)", ("task-1", 1, "later", payload, digest))

    def test_approval_status_is_constrained_and_pending_grants_can_expire(self) -> None:
        self.add_task()
        now = "2026-10-22T00:00:00Z"
        self.db.execute("INSERT INTO approvals(id,task_id,operation_sha256,summary_redacted,target_redacted,reason_redacted,expected_impact_redacted,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)", ("approval-1", "task-1", "0"*64, "write file", "/workspace/a.txt", "review", "file will change", "pending", now, "2026-10-22T00:05:00Z"))
        self.db.execute("UPDATE approvals SET status='expired' WHERE status IN ('pending','approved')")
        self.assertEqual(self.db.execute("SELECT status FROM approvals WHERE id='approval-1'").fetchone()[0], "expired")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE approvals SET status='auto-allowed' WHERE id='approval-1'")

    def test_checkpoint_transaction_rolls_back_partial_updates(self) -> None:
        self.add_task()
        payload = '{"schemaVersion":1,"status":"blocked"}'
        digest = hashlib.sha256(payload.encode()).hexdigest()
        self.db.execute("INSERT INTO checkpoints(task_id,version,created_at,state_json,sha256) VALUES(?,?,?,?,?)", ("task-1", 1, "now", payload, digest))
        self.db.commit()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("BEGIN")
            self.db.execute("UPDATE tasks SET checkpoint_version=2 WHERE id='task-1'")
            self.db.execute("INSERT INTO checkpoints(task_id,version,created_at,state_json,sha256) VALUES(?,?,?,?,?)", ("task-1", 1, "duplicate", payload, digest))
            self.db.commit()
        self.db.rollback()
        self.assertEqual(self.db.execute("SELECT checkpoint_version FROM tasks WHERE id='task-1'").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM checkpoints WHERE task_id='task-1'").fetchone()[0], 1)


    def test_evidence_artifact_schema_preserves_hash_and_project_scope(self) -> None:
        self.add_task()
        digest = hashlib.sha256(b"sample").hexdigest()
        self.db.execute("INSERT INTO evidence_artifacts(id,project_root,task_id,relative_path,name,suffix,size_bytes,modified_at,sha256,header_hex,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                        ("evidence-1", "/workspace", "task-1", "bin/sample.bin", "sample.bin", ".bin", 6, "now", digest, "73616d706c65", "now"))
        self.db.commit()
        row = self.db.execute("SELECT relative_path,sha256 FROM evidence_artifacts WHERE id='evidence-1'").fetchone()
        self.assertEqual(row, ("bin/sample.bin", digest))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO evidence_artifacts(id,project_root,relative_path,name,suffix,size_bytes,modified_at,sha256,header_hex,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                            ("evidence-2", "/missing", "x.bin", "x.bin", ".bin", 0, "now", digest, "", "now"))


    def test_model_provider_schema_never_has_plaintext_credential_column(self) -> None:
        columns = {row[1] for row in self.db.execute("PRAGMA table_info(model_providers)")}
        self.assertIn('workflow_config', {row[1] for row in self.db.execute("PRAGMA table_info(tasks)")})
        self.assertIn('workflow_config_sha256', {row[1] for row in self.db.execute("PRAGMA table_info(tasks)")})
        self.assertIn('encrypted_api_key', columns)
        self.assertNotIn('api_key', columns)
        self.assertIn('kind', columns)
        self.assertIn('base_url', columns)
        self.assertIn('model', columns)
        approval_columns = {row[1] for row in self.db.execute("PRAGMA table_info(approvals)")}
        self.assertIn('action_details_redacted', approval_columns)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO model_providers(id,name,kind,base_url,model,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", ('p-bad','bad','invalid','https://x','m','now','now'))

    def test_app_settings_can_hold_active_provider_reference(self) -> None:
        self.db.execute("INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)", ('active_provider_id','provider-1','now'))
        self.assertEqual(self.db.execute("SELECT value FROM app_settings WHERE key='active_provider_id'").fetchone()[0], 'provider-1')

    def test_events_are_bound_to_tasks(self) -> None:
        self.add_task()
        self.db.execute("INSERT INTO runtime_events(id,task_id,at,kind,title,detail) VALUES(?,?,?,?,?,?)", ("evt-1", "task-1", "now", "status", "Task blocked", "No provider configured"))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO runtime_events(id,task_id,at,kind,title,detail) VALUES(?,?,?,?,?,?)", ("evt-2", "missing", "now", "status", "x", "y"))


if __name__ == "__main__":
    unittest.main()
