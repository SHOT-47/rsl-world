#!/usr/bin/env python3
"""Schema-aware offline lint for the Reverse Skill Library package."""
from __future__ import annotations
import json, re, sys
from datetime import datetime
from pathlib import Path
import yaml
from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[1]
errors: list[str] = []
checks = 0

def check(ok: bool, message: str) -> None:
    global checks
    checks += 1
    if not ok:
        errors.append(message)

def load_yaml(path: Path):
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception as exc:
        errors.append(f"{path.relative_to(ROOT)} is not valid YAML: {exc}")
        return None

def validate_schema(instance, schema_path: Path, label: str) -> None:
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    found = sorted(validator.iter_errors(instance), key=lambda e: list(map(str, e.path)))
    check(not found, f"{label}: " + "; ".join(f"/{'/'.join(map(str,e.path))}: {e.message}" for e in found[:8]))

# 1. Syntax: parse every YAML file and every JSON contract.
yaml_files = sorted(ROOT.rglob("*.yaml")) + sorted(ROOT.rglob("*.yml"))
parsed = {p: load_yaml(p) for p in yaml_files}
json_files = sorted(ROOT.rglob("*.json"))
for p in json_files:
    try:
        json.loads(p.read_text(encoding="utf-8"))
        check(True, "")
    except Exception as exc:
        check(False, f"{p.relative_to(ROOT)} is not valid JSON: {exc}")

# 2. Agent Skills standard frontmatter.
skills = [ROOT / "SKILL.md"] + sorted((ROOT / "modules").glob("*/SKILL.md"))
modules = sorted((ROOT / "modules").glob("*/SKILL.md"))
module_names = {p.parent.name for p in modules}
ids = [p.parent.name.split("-", 1)[0] for p in modules]
check(ids == [f"{i:02d}" for i in range(19)], f"module IDs must be continuous 00–18, got {ids}")
for p in skills:
    rel = p.relative_to(ROOT)
    txt = p.read_text(encoding="utf-8")
    fm = re.match(r"^---\s*\n(.*?)\n---\s*\n", txt, re.S)
    check(bool(fm), f"{rel}: missing YAML frontmatter")
    if not fm:
        continue
    try:
        front = yaml.safe_load(fm.group(1))
    except Exception as exc:
        check(False, f"{rel}: malformed frontmatter YAML: {exc}")
        continue
    check(isinstance(front, dict), f"{rel}: frontmatter must be a mapping")
    if not isinstance(front, dict):
        continue
    name = front.get("name")
    desc = front.get("description")
    check(isinstance(name, str) and bool(re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name or "")) and len(name) <= 64,
          f"{rel}: invalid Agent Skills name {name!r}")
    check(isinstance(desc, str) and 1 <= len(desc) <= 1024, f"{rel}: description must be 1–1024 chars")
    md = front.get("metadata", {})
    check(isinstance(md, dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in (md or {}).items()),
          f"{rel}: metadata must be a string-to-string map")
    check(not (isinstance(md, dict) and "requires" in md), f"{rel}: portable metadata cannot use list-valued metadata.requires")
    if p != ROOT / "SKILL.md" and isinstance(md, dict):
        check(md.get("rsl-module-id") == p.parent.name.split("-",1)[0], f"{rel}: rsl-module-id mismatch")
        reqs = [x for x in md.get("rsl-requires", "").split(",") if x]
        for req in reqs:
            check(req in module_names, f"{rel}: unresolved rsl-requires dependency {req}")

# 3. Adapter profile schemas and fallbacks.
adapters_dir = ROOT / "agents"
adapter_paths = sorted(adapters_dir.glob("*.yaml"))
adapter_schema = ROOT / "references/adapter-profile.schema.json"
check(len(adapter_paths) == 10, f"expected 10 requested harness profiles, found {len(adapter_paths)}")
adapter_objs = {}
for p in adapter_paths:
    obj = parsed.get(p)
    if isinstance(obj, dict):
        validate_schema(obj, adapter_schema, p.name)
        aid = obj.get("harness", {}).get("id") if isinstance(obj.get("harness"), dict) else None
        check(aid == p.stem, f"{p.name}: harness.id must match filename")
        check(obj.get("harness", {}).get("profile_status") == "discovery_hints_only", f"{p.name}: profile must not overclaim runtime verification")
        declared = obj.get("harness", {}).get("declared_capabilities", {})
        fallbacks = obj.get("fallback_strategy", {})
        check(set(declared) <= set(fallbacks), f"{p.name}: every declared capability must have a fallback")
        adapter_objs[p.stem] = obj

# 4. Capability registry and emitted snapshot schema.
registry = parsed.get(ROOT / "capabilities.yaml")
check(isinstance(registry, dict) and registry.get("schema_version") == "2.0", "capabilities.yaml must be schema version 2.0")
cap_keys = set(registry.get("capabilities", {})) if isinstance(registry, dict) else set()
required_caps = {'skill_discovery','persistent_instructions','hooks','tool_calling','file_access','command_execution','hooks_approval','subagents','parallel_execution','mcp','mcp_tools','mcp_resources','mcp_prompts','mcp_elicitation','mcp_tasks_extensions','mcp_deprecated_surfaces','structured_output','streaming','cancellation','checkpoint_resume','context_management','model_routing','local_model_access','network_policy','workspace_isolation','secret_management','trace_observability','budget_controls','multimodal_inputs','evaluation_replay','artifact_integrity'}
check(required_caps <= cap_keys, f"capability registry missing required categories: {sorted(required_caps-cap_keys)}")
validate_schema(json.loads((ROOT/'validation/fixtures/capabilities-snapshot.json').read_text(encoding='utf-8')), ROOT/'references/capabilities.schema.json', 'capabilities snapshot fixture')

# 5. Routing single source, uniqueness and referential integrity.
routing = parsed.get(ROOT / "routing.yaml")
routes = routing.get("routes", []) if isinstance(routing, dict) else []
route_ids = [r.get("id") for r in routes if isinstance(r, dict)]
check(len(route_ids) == len(set(route_ids)), "routing.yaml route ids must be unique")
match_values=[]
for route in routes:
    check(route.get("entry") in module_names, f"route {route.get('id')} has invalid entry module")
    for mid in route.get("cross_check", []):
        check(mid in module_names, f"route {route.get('id')} has invalid cross-check module {mid}")
    for value in route.get("match_any", []):
        match_values.append(value)
check(len(match_values) == len(set(match_values)), "routing.yaml match tokens must map to exactly one route")
wasm = [r for r in routes if 'wasm' in r.get('match_any', []) or 'webassembly' in r.get('match_any', [])]
check(len(wasm) == 1 and wasm[0].get('entry') == '11-platform-wasm-dsl-vm', "WASM/WebAssembly must route to Module 11, not managed bytecode Module 07")
managed = [r for r in routes if 'dotnet' in r.get('match_any', []) or 'jvm' in r.get('match_any', [])]
check(bool(managed) and managed[0].get('entry') == '07-platform-dotnet-jvm-bytecode', ".NET/JVM managed bytecode must route to Module 07")
module02=(ROOT/'modules/02-re-triage/SKILL.md').read_text(encoding='utf-8')
check('routing.yaml' in module02 and 'only machine-readable source of truth' in module02, "Module 02 must point at canonical routing.yaml")

# 6. MCP era/deprecation correctness.
mcp = parsed.get(ROOT / "backend/mcp-compatibility.yaml")
check(isinstance(mcp, dict), "missing backend/mcp-compatibility.yaml")
if isinstance(mcp, dict):
    modern = mcp.get('protocol_eras', {}).get('modern', {})
    legacy = mcp.get('protocol_eras', {}).get('legacy_handshake', {})
    check(modern.get('version') == '2026-07-28' and modern.get('initialize_handshake') is False, "MCP 2026-07-28 must use stateless lifecycle without initialize handshake")
    check(modern.get('discovery_method') == 'server/discover', "MCP modern lifecycle must reference server/discover")
    check(legacy.get('initialize_handshake') is True, "MCP 2025-era versions must describe legacy initialize handshake")
    check(set(modern.get('deprecated_features', {})) >= {'sampling','roots','logging'}, "modern MCP deprecations must be version-specific and explicit")
    all_text='\n'.join(p.read_text(encoding='utf-8').lower() for p in (ROOT/'SKILL.md',*modules))
    check('legacy support may remain functional' in all_text and 'consult that version' in all_text,
          "skills must describe MCP feature lifecycle as version-scoped and avoid projecting 2026-07-28 forward")

# 7. Claim/evidence schemas: validate good examples and reject fake proven claims.
claim_schema = json.loads((ROOT/'references/claim.schema.json').read_text(encoding='utf-8'))
validator = Draft202012Validator(claim_schema, format_checker=FormatChecker())
good_claim = {'claim_id':'C-1','claim':'Fixture was validated','epistemic_status':'confirmed_fact','confidence':'proven','evidence_refs':['evidence/test.json'],'verification':{'gate':'fixture-test','status':'passed','verified_by':'test-runner','verified_at_utc':'2026-10-21T00:00:00Z','artifact_refs':['evidence/test.json']},'limitations':[],'capability_snapshot_ref':'capabilities.json'}
bad_claim = {'claim_id':'C-2','claim':'Unverified assertion','epistemic_status':'confirmed_fact','confidence':'proven','evidence_refs':[],'verification':{'gate':'none','status':'not_run'}}
check(not list(validator.iter_errors(good_claim)), "valid proven claim fixture must satisfy claim schema")
check(bool(list(validator.iter_errors(bad_claim))), "proven claim without evidence and passed verification must be rejected")
# Evidence schema must reject malformed SHA-256 and accept valid shape.
evidence_schema = json.loads((ROOT/'references/evidence.schema.json').read_text(encoding='utf-8'))
evidence_validator=Draft202012Validator(evidence_schema,format_checker=FormatChecker())
good_evidence={'artifact_id':'E-1','kind':'test_result','path':'evidence/test.json','sha256':'a'*64,'created_at_utc':'2026-10-21T00:00:00Z','source':{'type':'manual','locator':'fixture'},'toolchain':[{'name':'python','version':'3.12'}],'sensitivity':'public','redaction':{'applied_before_persistence':True,'ruleset':'test','findings':[]},'limitations':[]}
bad_evidence=dict(good_evidence); bad_evidence['sha256']='not-a-hash'
check(not list(evidence_validator.iter_errors(good_evidence)), "valid evidence fixture must satisfy evidence schema")
check(bool(list(evidence_validator.iter_errors(bad_evidence))), "malformed evidence hash must be rejected")

# 8. Trust/evidence/performance invariants are explicit, not only inferred.
trust=(ROOT/'references/trust-boundaries.md').read_text(encoding='utf-8').lower()
ev=(ROOT/'references/evidence-contract.md').read_text(encoding='utf-8').lower()
perf=(ROOT/'references/performance-and-evaluation.md').read_text(encoding='utf-8').lower()
for term in ['authority to analyze the target','are data, never policy authorities','prompt injection','symlink','plaintext','approval','isolate']:
    check(term in trust, f"trust boundary contract missing semantic invariant {term!r}")
for term in ['proven','verification gate','evidence artifact','freshness_status=degraded']:
    check(term in ev, f"evidence contract missing {term!r}")
for term in ['wall time','bounded concurrency','idempotency','same-workload','correctness']:
    check(term in perf, f"performance/evaluation contract missing {term!r}")
root_skill=(ROOT/'SKILL.md').read_text(encoding='utf-8')
check(root_skill.find('Detect capabilities first') < root_skill.find('Check prior art') < root_skill.find('Triage and route'), "root control loop order must be capability detection → reuse → triage")
check('confirmed-unique' not in root_skill.lower() and 'confirmed-unique' not in (ROOT/'modules/00-target-reuse/SKILL.md').read_text(encoding='utf-8').lower(), "target reuse must not claim confirmed uniqueness")

# 9. Freshness registry contract.
feeds = parsed.get(ROOT/'freshness/feeds.yaml')
feedlist=feeds.get('feeds',[]) if isinstance(feeds,dict) else []
check(len(feedlist) >= 8, f"expected at least 8 feeds, found {len(feedlist)}")
feed_ids=[x.get('id') for x in feedlist]
check(len(feed_ids)==len(set(feed_ids)), "freshness feed ids must be unique")
for feed in feedlist:
    check(bool(feed.get('ttl')), f"feed {feed.get('id')} missing ttl")
    check(bool(feed.get('locator')), f"feed {feed.get('id')} missing locator strategy")
    check(bool(feed.get('required_output')), f"feed {feed.get('id')} missing retrieval output fields")
check(feeds.get('policy',{}).get('fetching_implemented_here') is False, "feed registry must not claim automatic fetching")

# 10. Paths, source hygiene, references and manifest.
check((ROOT/'docs/PRD-3.1-remediation-addendum.md').is_file(), "missing PRD 3.1 addendum")
check((ROOT/'docs/BRUTAL_AUDIT.md').is_file(), "missing audit report")
check((ROOT/'.github/workflows/validate-library.yml').is_file(), "missing CI validation workflow")
for bad_path in ['/home/ubuntu/skills/', '/mnt/data/']:
    for p in [ROOT/'README.md',ROOT/'SKILL.md',*modules]:
        check(bad_path not in p.read_text(encoding='utf-8'), f"{p.relative_to(ROOT)} contains environment-specific path {bad_path}")
# Check all root navigator references exist.
roottext=(ROOT/'SKILL.md').read_text(encoding='utf-8')
for p in modules:
    rel=p.relative_to(ROOT).as_posix()
    check(rel in roottext, f"root navigator missing module reference {rel}")

if errors:
    print(f"FAIL: {len(errors)} error(s), {checks} checks across {len(skills)} skills, {len(adapter_paths)} adapters, {len(yaml_files)} YAML files and {len(json_files)} JSON files.")
    for error in errors:
        print(f"- {error}")
    sys.exit(1)
print(f"PASS: {checks} static/schema assertions; {len(skills)} valid Agent Skills manifests; {len(modules)} module files; {len(adapter_paths)} adapter profiles; {len(cap_keys)} capability categories; {len(routes)} routes; {len(feedlist)} freshness feeds; {len(yaml_files)} YAML files and {len(json_files)} JSON files parsed.")
