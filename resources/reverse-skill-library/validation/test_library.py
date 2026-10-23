"""Offline contract tests for RSL. These do not claim live harness conformance."""
from __future__ import annotations
import json
import hashlib
import re
import tempfile
import unittest
from pathlib import Path
import yaml
from jsonschema import Draft202012Validator, FormatChecker

import export_skill
import validate_case

ROOT = Path(__file__).resolve().parents[1]


def read_frontmatter(path: Path):
    text = path.read_text(encoding="utf-8")
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n", text, re.S)
    if not m:
        raise AssertionError(f"missing YAML frontmatter: {path}")
    return yaml.safe_load(m.group(1))


def route_for(token: str, routing: dict) -> dict:
    """Small test-side oracle for the declarative route contract, not an RE engine."""
    normalized = token.strip().lower()
    matches = [r for r in routing["routes"] if normalized in [x.lower() for x in r.get("match_any", [])]]
    if len(matches) == 1:
        r = matches[0]
        return {"status": "ROUTED", "route_id": r["id"], "entry": r["entry"], "cross_check": list(r["cross_check"])}
    if not matches:
        return {"status": routing["no_route"]["status"], "route_id": None, "entry": None, "cross_check": []}
    return {"status": "AMBIGUOUS_ROUTE", "route_id": None, "entry": None, "cross_check": []}


class PackageSyntaxTests(unittest.TestCase):
    def test_all_yaml_files_parse(self):
        files = sorted(ROOT.rglob("*.yaml")) + sorted(ROOT.rglob("*.yml"))
        self.assertGreaterEqual(len(files), 14)
        for path in files:
            with self.subTest(path=path.relative_to(ROOT)):
                yaml.safe_load(path.read_text(encoding="utf-8"))

    def test_all_json_files_parse(self):
        files = sorted(ROOT.rglob("*.json"))
        self.assertGreaterEqual(len(files), 5)
        for path in files:
            with self.subTest(path=path.relative_to(ROOT)):
                json.loads(path.read_text(encoding="utf-8"))

    def test_agent_skill_frontmatter_is_portable(self):
        paths = [ROOT / "SKILL.md", *sorted((ROOT / "modules").glob("*/SKILL.md"))]
        self.assertEqual(len(paths), 20)
        for path in paths:
            with self.subTest(path=path.relative_to(ROOT)):
                fm = read_frontmatter(path)
                name = fm["name"]
                self.assertRegex(name, r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
                self.assertLessEqual(len(name), 64)
                self.assertGreaterEqual(len(fm["description"]), 1)
                self.assertLessEqual(len(fm["description"]), 1024)
                metadata = fm.get("metadata", {})
                self.assertIsInstance(metadata, dict)
                self.assertTrue(all(isinstance(k, str) and isinstance(v, str) for k, v in metadata.items()))
                self.assertNotIn("requires", metadata)
                if path != ROOT / "SKILL.md":
                    self.assertEqual(name, path.parent.name)
                    self.assertEqual(metadata["rsl-module-id"], path.parent.name.split("-", 1)[0])

    def test_module_ids_and_dependencies_resolve(self):
        paths = sorted((ROOT / "modules").glob("*/SKILL.md"))
        names = {p.parent.name for p in paths}
        self.assertEqual([p.parent.name.split("-", 1)[0] for p in paths], [f"{n:02d}" for n in range(19)])
        for path in paths:
            meta = read_frontmatter(path).get("metadata", {})
            requires = [v for v in meta.get("rsl-requires", "").split(",") if v]
            for req in requires:
                with self.subTest(module=path.parent.name, requirement=req):
                    self.assertIn(req, names)

    def test_all_adapter_profiles_match_schema(self):
        schema = json.loads((ROOT / "references/adapter-profile.schema.json").read_text(encoding="utf-8"))
        validator = Draft202012Validator(schema, format_checker=FormatChecker())
        paths = sorted((ROOT / "agents").glob("*.yaml"))
        self.assertEqual(len(paths), 10)
        required_capabilities = set()
        for path in paths:
            with self.subTest(adapter=path.stem):
                obj = yaml.safe_load(path.read_text(encoding="utf-8"))
                errs = list(validator.iter_errors(obj))
                self.assertEqual(errs, [], "; ".join(e.message for e in errs))
                self.assertEqual(obj["harness"]["id"], path.stem)
                self.assertFalse(obj["verification"]["runtime_verified"])
                self.assertTrue(set(obj["harness"]["declared_capabilities"]) <= set(obj["fallback_strategy"]))
                required_capabilities |= set(obj["harness"]["declared_capabilities"])
        self.assertGreaterEqual(len(required_capabilities), 20)

    def test_schema_files_have_correct_draft(self):
        for name in ["capabilities.schema.json", "claim.schema.json", "evidence.schema.json", "triage.schema.json", "adapter-profile.schema.json"]:
            with self.subTest(name=name):
                schema = json.loads((ROOT / "references" / name).read_text(encoding="utf-8"))
                self.assertEqual(schema["$schema"], "https://json-schema.org/draft/2020-12/schema")
                Draft202012Validator.check_schema(schema)



    def test_module_output_instructions_match_schema_keys(self):
        module01 = (ROOT / "modules/01-detect-capabilities/SKILL.md").read_text(encoding="utf-8")
        module02 = (ROOT / "modules/02-re-triage/SKILL.md").read_text(encoding="utf-8")
        cap_schema = json.loads((ROOT / "references/capabilities.schema.json").read_text(encoding="utf-8"))
        triage_schema = json.loads((ROOT / "references/triage.schema.json").read_text(encoding="utf-8"))
        self.assertIn("observed_at_utc", cap_schema["required"])
        self.assertIn("observed_at_utc", module01)
        self.assertNotIn("`observed_at`", module01)
        self.assertIn("selected_cross_check_skills", triage_schema["required"])
        self.assertIn("selected_cross_check_skills", module02)
        self.assertNotIn("selected_cross_check_skill`", module02)
        self.assertIn("capabilities.json", module01)
        self.assertNotIn("Read `case/capabilities.json` before relying", module01)


class RoutingContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.routing = yaml.safe_load((ROOT / "routing.yaml").read_text(encoding="utf-8"))
        cls.module_names = {p.parent.name for p in (ROOT / "modules").glob("*/SKILL.md")}

    def test_route_is_deterministic_for_all_declared_tokens(self):
        tokens = [token for r in self.routing["routes"] for token in r["match_any"]]
        for token in tokens:
            with self.subTest(token=token):
                results = [json.dumps(route_for(token, self.routing), sort_keys=True) for _ in range(3)]
                self.assertEqual(results[0], results[1])
                self.assertEqual(results[1], results[2])

    def test_no_route_does_not_guess(self):
        result = route_for("mystery-container-format", self.routing)
        self.assertEqual(result["status"], "NO_ROUTE")
        self.assertIsNone(result["entry"])

    def test_wasm_does_not_route_to_managed_bytecode(self):
        self.assertEqual(route_for("wasm", self.routing)["entry"], "11-platform-wasm-dsl-vm")
        self.assertEqual(route_for("webassembly", self.routing)["entry"], "11-platform-wasm-dsl-vm")
        self.assertEqual(route_for("jvm", self.routing)["entry"], "07-platform-dotnet-jvm-bytecode")
        self.assertEqual(route_for("dotnet", self.routing)["entry"], "07-platform-dotnet-jvm-bytecode")

    def test_every_route_target_exists_and_tokens_are_unique(self):
        tokens = []
        for route in self.routing["routes"]:
            self.assertIn(route["entry"], self.module_names)
            for mid in route["cross_check"]:
                self.assertIn(mid, self.module_names)
            tokens.extend(route["match_any"])
        self.assertEqual(len(tokens), len(set(tokens)))

    def test_triage_module_declares_routing_source_of_truth(self):
        text = (ROOT / "modules/02-re-triage/SKILL.md").read_text(encoding="utf-8")
        self.assertIn("routing.yaml", text)
        self.assertIn("only machine-readable source of truth", text)


class CapabilityAndMCPTests(unittest.TestCase):
    def test_capability_registry_covers_agent_runtime_surfaces(self):
        registry = yaml.safe_load((ROOT / "capabilities.yaml").read_text(encoding="utf-8"))
        caps = registry["capabilities"]
        expected = {"skill_discovery", "hooks", "tool_calling", "file_access", "command_execution", "subagents", "parallel_execution", "mcp", "structured_output", "streaming", "cancellation", "checkpoint_resume", "context_management", "model_routing", "local_model_access", "network_policy", "workspace_isolation", "secret_management", "trace_observability", "budget_controls", "multimodal_inputs", "evaluation_replay", "artifact_integrity"}
        self.assertTrue(expected <= set(caps))
        for name, contract in caps.items():
            with self.subTest(capability=name):
                self.assertTrue(contract.get("detect"))
                self.assertTrue(contract.get("fallback"))

    def test_unknown_capabilities_are_valid_not_silently_false(self):
        schema = json.loads((ROOT / "references/capabilities.schema.json").read_text(encoding="utf-8"))
        fixture = json.loads((ROOT / "validation/fixtures/capabilities-snapshot.json").read_text(encoding="utf-8"))
        Draft202012Validator(schema, format_checker=FormatChecker()).validate(fixture)
        self.assertEqual(fixture["capabilities"]["hooks"]["status"], "unknown")

    def test_modern_and_legacy_mcp_lifecycles_are_distinct(self):
        cfg = yaml.safe_load((ROOT / "backend/mcp-compatibility.yaml").read_text(encoding="utf-8"))
        modern = cfg["protocol_eras"]["modern"]
        legacy = cfg["protocol_eras"]["legacy_handshake"]
        self.assertEqual(modern["version"], "2026-07-28")
        self.assertFalse(modern["initialize_handshake"])
        self.assertEqual(modern["discovery_method"], "server/discover")
        self.assertTrue(legacy["initialize_handshake"])
        self.assertIn("2025-11-25", legacy["versions"])

    def test_deprecated_mcp_features_are_version_dependent(self):
        cfg = yaml.safe_load((ROOT / "backend/mcp-compatibility.yaml").read_text(encoding="utf-8"))
        old = cfg["protocol_eras"]["modern"]["deprecated_features"]
        self.assertEqual(set(old), {"sampling", "roots", "logging"})
        for name, value in old.items():
            with self.subTest(feature=name):
                self.assertEqual(value["status"], "deprecated")
                self.assertTrue(value["migration"])
        text = (ROOT / "modules/01-detect-capabilities/SKILL.md").read_text(encoding="utf-8")
        self.assertIn("2026-07-28", text)
        self.assertIn("2025-11-25", text)
        self.assertIn("server/discover", text)

    def test_backend_manifests_do_not_pin_unverified_protocol_lifecycle(self):
        for name in ["rea.yaml", "ghidra-mcp.yaml"]:
            with self.subTest(name=name):
                cfg = yaml.safe_load((ROOT / "backend" / name).read_text(encoding="utf-8"))
                self.assertEqual(cfg["protocol_support"], "unknown_until_detected")
                self.assertEqual(cfg["protocol_contract"], "backend/mcp-compatibility.yaml")


class EvidenceAndSafetyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.claim_schema = json.loads((ROOT / "references/claim.schema.json").read_text(encoding="utf-8"))
        cls.claim_validator = Draft202012Validator(cls.claim_schema, format_checker=FormatChecker())
        cls.evidence_schema = json.loads((ROOT / "references/evidence.schema.json").read_text(encoding="utf-8"))
        cls.evidence_validator = Draft202012Validator(cls.evidence_schema, format_checker=FormatChecker())

    def test_claim_contract_rejects_proven_without_evidence(self):
        claim = {"claim_id":"C-1","claim":"Untested","epistemic_status":"confirmed_fact","confidence":"proven","evidence_refs":[],"verification":{"gate":"test","status":"not_run"}}
        self.assertTrue(list(self.claim_validator.iter_errors(claim)))

    def test_claim_contract_accepts_proven_only_with_passed_gate_and_verifier(self):
        claim = {"claim_id":"C-2","claim":"Fixture output matches baseline","epistemic_status":"confirmed_fact","confidence":"proven","evidence_refs":["evidence/test.json"],"verification":{"gate":"differential-test","status":"passed","verified_by":"test-runner","verified_at_utc":"2026-10-21T00:00:00Z","artifact_refs":["evidence/test.json"]},"limitations":[]}
        self.assertEqual(list(self.claim_validator.iter_errors(claim)), [])
        claim["verification"]["status"] = "failed"
        self.assertTrue(list(self.claim_validator.iter_errors(claim)))

    def test_evidence_contract_rejects_invalid_hash(self):
        evidence = {"artifact_id":"E-1","kind":"test_result","path":"evidence/test.json","sha256":"abc","created_at_utc":"2026-10-21T00:00:00Z","source":{"type":"manual","locator":"fixture"},"toolchain":[{"name":"python","version":"3.12"}],"sensitivity":"public","redaction":{"applied_before_persistence":True,"ruleset":"test","findings":[]},"limitations":[]}
        self.assertTrue(list(self.evidence_validator.iter_errors(evidence)))
        evidence["sha256"] = "a" * 64
        self.assertEqual(list(self.evidence_validator.iter_errors(evidence)), [])

    def test_trust_boundary_covers_injection_scope_secrets_and_isolation(self):
        text = (ROOT / "references/trust-boundaries.md").read_text(encoding="utf-8").lower()
        for term in ["prompt injection", "untrusted", "scope", "credential", "plaintext", "isolate", "approval", "symlink", "authority to analyze the target"]:
            with self.subTest(term=term):
                self.assertIn(term, text)

    def test_root_control_order_and_target_reuse_uncertainty(self):
        root = (ROOT / "SKILL.md").read_text(encoding="utf-8")
        self.assertLess(root.index("Detect capabilities first"), root.index("Check prior art"))
        self.assertLess(root.index("Check prior art"), root.index("Triage and route"))
        m00 = (ROOT / "modules/00-target-reuse/SKILL.md").read_text(encoding="utf-8").lower()
        self.assertIn("no_match_found_in_searched_sources", m00)
        self.assertNotIn("confirmed-unique", m00)
        for spec in (ROOT / "validation/specs").glob("*.md"):
            self.assertNotIn("confirmed-unique", spec.read_text(encoding="utf-8").lower())

    def test_performance_guidance_contains_guardrails(self):
        text = (ROOT / "references/performance-and-evaluation.md").read_text(encoding="utf-8").lower()
        for term in ["bounded concurrency", "idempotency", "same-workload", "wall time", "correctness", "cache"]:
            with self.subTest(term=term):
                self.assertIn(term, text)

    def test_freshness_registry_never_claims_fetching_is_implemented(self):
        feeds = yaml.safe_load((ROOT / "freshness/feeds.yaml").read_text(encoding="utf-8"))
        self.assertFalse(feeds["policy"]["fetching_implemented_here"])
        self.assertGreaterEqual(len(feeds["feeds"]), 8)
        for feed in feeds["feeds"]:
            self.assertIn("locator", feed)
            self.assertIn("ttl", feed)
            self.assertIn("required_output", feed)


class CaseValidatorTests(unittest.TestCase):
    def _make_case(self, root: Path, bad_hash: bool = False, unsafe_claim_ref: bool = False):
        (root / "claims").mkdir(parents=True)
        (root / "evidence/records").mkdir(parents=True)
        (root / "evidence/harness-detection.json").write_text('{"harness":"generic"}\n', encoding="utf-8")
        (root / "evidence/triage.json").write_text('{"route":"wasm"}\n', encoding="utf-8")
        artifact = root / "evidence/test.bin"
        artifact.write_bytes(b"RSL validation fixture\n")
        def write_record(artifact_id, relpath, kind, wrong_hash=False):
            target = root / relpath
            digest = hashlib.sha256(target.read_bytes()).hexdigest()
            record = {"artifact_id":artifact_id,"kind":kind,"path":relpath,"sha256":("0"*64 if wrong_hash else digest),
                      "created_at_utc":"2026-10-21T00:00:00Z","source":{"type":"manual","locator":"unit-test fixture"},
                      "toolchain":[{"name":"python","version":"3.12"}],"sensitivity":"public",
                      "redaction":{"applied_before_persistence":True,"ruleset":"test","findings":[]},"limitations":[]}
            (root / "evidence/records" / f"{artifact_id}.json").write_text(json.dumps(record), encoding="utf-8")
        write_record("E-HARNESS", "evidence/harness-detection.json", "input_metadata")
        write_record("E-TRIAGE", "evidence/triage.json", "test_result")
        digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
        (root / "capabilities.json").write_text(json.dumps({
            "schema_version":"2.0", "observed_at_utc":"2026-10-21T00:00:00Z", "snapshot_id":"cap-1",
            "harness":{"id":"generic","version":None,"profile_status":"discovery_hints_only","evidence_refs":["evidence/harness-detection.json"]},
            "capabilities":{"hooks":{"status":"unknown","detection_method":"no probe available","evidence_refs":[],"fallback_state":"manual"}},
            "backend":{"status":"not_applicable","protocol_version":None,"lifecycle_mode":"not_applicable","server_name":None,"server_version":None,"transport":None,"primitives":[],"extensions":[],"evidence_refs":[]},
            "fallback_summary":"unknown capabilities use manual gates"
        }), encoding="utf-8")
        (root / "triage.json").write_text(json.dumps({
            "status":"ROUTED","format":"wasm","architecture":"wasm32", "protection_signals":[],
            "selected_entry_skill":"11-platform-wasm-dsl-vm", "selected_cross_check_skills":["03-static-binary", "04-dynamic-instrument"],
            "route_id":"wasm", "capability_snapshot_ref":"capabilities.json", "evidence_refs":["evidence/triage.json"], "limitations":[]
        }), encoding="utf-8")
        record = {"artifact_id":"E-1","kind":"test_result","path":"evidence/test.bin","sha256":("0"*64 if bad_hash else digest),
                  "created_at_utc":"2026-10-21T00:00:00Z","source":{"type":"manual","locator":"unit-test fixture"},
                  "toolchain":[{"name":"python","version":"3.12"}],"sensitivity":"public",
                  "redaction":{"applied_before_persistence":True,"ruleset":"test","findings":[]},"limitations":[]}
        (root / "evidence/records/E-1.json").write_text(json.dumps(record), encoding="utf-8")
        ref = "../outside.txt" if unsafe_claim_ref else "evidence/test.bin"
        (root / "claims/C-1.json").write_text(json.dumps({
            "claim_id":"C-1","claim":"Fixture validated","epistemic_status":"confirmed_fact","confidence":"proven",
            "evidence_refs":[ref],"verification":{"gate":"unit-test","status":"passed","verified_by":"test-runner",
            "verified_at_utc":"2026-10-21T00:00:00Z","artifact_refs":[ref]},"limitations":[],"capability_snapshot_ref":"capabilities.json"
        }), encoding="utf-8")

    def test_valid_case_passes_schema_reference_and_hash_checks(self):
        with tempfile.TemporaryDirectory() as tmp:
            case = Path(tmp) / "case"
            case.mkdir()
            self._make_case(case)
            result = validate_case.validate_case(case)
            self.assertEqual(result["status"], "PASS", result["errors"])
            self.assertEqual(result["counts"]["artifact_hashes"], 3)
            self.assertGreaterEqual(result["counts"]["references"], 5)

    def test_case_validator_requires_metadata_sidecar_for_referenced_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            case = Path(tmp) / "case"
            case.mkdir()
            self._make_case(case)
            record = case / "evidence/records/E-1.json"
            record.unlink()
            result = validate_case.validate_case(case)
            self.assertEqual(result["status"], "FAIL")
            self.assertTrue(any("no matching evidence/records" in x for x in result["errors"]))

    def test_case_validator_rejects_triage_route_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            case = Path(tmp) / "case"
            case.mkdir()
            self._make_case(case)
            triage_path = case / "triage.json"
            triage = json.loads(triage_path.read_text(encoding="utf-8"))
            triage["selected_entry_skill"] = "07-platform-dotnet-jvm-bytecode"
            triage_path.write_text(json.dumps(triage), encoding="utf-8")
            result = validate_case.validate_case(case)
            self.assertEqual(result["status"], "FAIL")
            self.assertTrue(any("does not match routing.yaml entry" in x for x in result["errors"]))

    def test_malformed_capability_json_reports_failure_without_crashing(self):
        with tempfile.TemporaryDirectory() as tmp:
            case = Path(tmp) / "case"
            case.mkdir()
            (case / "capabilities.json").write_text("{not-json", encoding="utf-8")
            result = validate_case.validate_case(case, allow_partial=True)
            self.assertEqual(result["status"], "FAIL")
            self.assertTrue(any("invalid JSON" in x for x in result["errors"]))

    def test_case_validator_rejects_artifact_hash_mismatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            case = Path(tmp) / "case"
            case.mkdir()
            self._make_case(case, bad_hash=True)
            result = validate_case.validate_case(case)
            self.assertEqual(result["status"], "FAIL")
            self.assertTrue(any("SHA-256 mismatch" in x for x in result["errors"]))

    def test_case_validator_rejects_path_traversal_in_claims(self):
        with tempfile.TemporaryDirectory() as tmp:
            case = Path(tmp) / "case"
            case.mkdir()
            self._make_case(case, unsafe_claim_ref=True)
            result = validate_case.validate_case(case)
            self.assertEqual(result["status"], "FAIL")
            self.assertTrue(any("unsafe/absolute reference" in x for x in result["errors"]))

    def test_partial_mode_allows_missing_triage_only_when_explicit(self):
        with tempfile.TemporaryDirectory() as tmp:
            case = Path(tmp) / "case"
            case.mkdir()
            self._make_case(case)
            (case / "triage.json").unlink()
            result = validate_case.validate_case(case, allow_partial=True)
            self.assertEqual(result["status"], "PASS", result["errors"])
            strict = validate_case.validate_case(case, allow_partial=False)
            self.assertEqual(strict["status"], "FAIL")


class AdapterFreshnessTests(unittest.TestCase):
    def _profile(self, name):
        return yaml.safe_load((ROOT / "agents" / f"{name}.yaml").read_text(encoding="utf-8"))

    def test_cursor_agent_skills_roots_match_current_documentation(self):
        profile = self._profile("cursor")
        paths = set(profile["harness"]["discovery_hints"]["skill_paths"])
        self.assertTrue({".agents/skills/", ".cursor/skills/", "~/.agents/skills/", "~/.cursor/skills/", ".claude/skills/", ".codex/skills/"} <= paths)
        self.assertEqual(profile["harness"]["declared_capabilities"]["agent_skills"], "documented")
        self.assertFalse(profile["verification"]["runtime_verified"])

    def test_grok_documented_features_are_not_mislabeled_runtime_verified(self):
        profile = self._profile("grok-build")
        hints = profile["harness"]["discovery_hints"]
        self.assertIn("./.grok/skills/", hints["skill_paths"])
        self.assertIn("~/.grok/skills/", hints["skill_paths"])
        self.assertEqual(profile["harness"]["declared_capabilities"]["agent_skills"], "documented")
        self.assertEqual(profile["harness"]["declared_capabilities"]["hooks"], "documented")
        self.assertEqual(profile["harness"]["declared_capabilities"]["subagents"], "documented")
        self.assertEqual(profile["harness"]["declared_capabilities"]["mcp"], "documented")
        self.assertFalse(profile["verification"]["runtime_verified"])
        self.assertIn("fail-open behavior", " ".join(hints["hook_configuration_hints"]))

    def test_windsurf_profile_discloses_documentation_transition(self):
        profile = self._profile("windsurf")
        basis = profile["harness"]["compatibility_basis"].lower()
        self.assertIn("redirects to devin desktop", basis)
        self.assertFalse(profile["verification"]["runtime_verified"])
        self.assertIn("legacy discovery hint only", " ".join(profile["harness"]["discovery_hints"]["rules_paths"]))

    def test_codex_docs_do_not_imply_api_and_cli_feature_equivalence(self):
        profile = self._profile("codex")
        basis = profile["harness"]["compatibility_basis"].lower()
        self.assertIn("not interchangeable", basis)
        self.assertFalse(profile["verification"]["runtime_verified"])


class ExportTests(unittest.TestCase):
    def test_every_adapter_exports_a_single_skill_without_overwriting(self):
        harnesses = sorted(p.stem for p in (ROOT / "agents").glob("*.yaml"))
        self.assertEqual(len(harnesses), 10)
        for harness in harnesses:
            with self.subTest(harness=harness), tempfile.TemporaryDirectory() as tmp:
                dest = Path(tmp)
                output = export_skill.export_skill(harness, dest, source_root=ROOT)
                self.assertTrue((output / "SKILL.md").is_file())
                self.assertTrue((output / "EXPORT.json").is_file())
                self.assertEqual(list((output / "modules").glob("*/SKILL.md")), [])
                self.assertEqual(len(list(output.rglob("SKILL.md"))), 1)
                export_manifest = json.loads((output / "EXPORT.json").read_text(encoding="utf-8"))
                self.assertFalse(export_manifest["installed_into_harness"])
                self.assertFalse(export_manifest["runtime_verified"])
                self.assertTrue((output / "modules/00-target-reuse/MODULE.md").is_file())
                self.assertIn("modules/00-target-reuse/MODULE.md", (output / "SKILL.md").read_text(encoding="utf-8"))
                with self.assertRaises(FileExistsError):
                    export_skill.export_skill(harness, dest, source_root=ROOT)

    def test_unknown_harness_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                export_skill.export_skill("not-a-harness", Path(tmp), source_root=ROOT)


if __name__ == "__main__":
    unittest.main(verbosity=2)
