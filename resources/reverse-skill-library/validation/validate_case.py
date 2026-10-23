#!/usr/bin/env python3
"""Validate an RSL case directory, JSON contracts, safe references and artifact hashes.

Expected layout (relative to CASE_DIR):
  capabilities.json
  triage.json                 required unless --allow-partial
  claims/*.json               claim records
  evidence/records/*.json     evidence metadata sidecars
  evidence/...                content artifacts referenced by the sidecars

This validates local package integrity, not the truth of the analysis or live harness conformance.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import sys
from pathlib import Path, PurePosixPath
from typing import Any
from jsonschema import Draft202012Validator, FormatChecker
import yaml

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
SCHEMAS = {
    "capabilities": PACKAGE_ROOT / "references/capabilities.schema.json",
    "triage": PACKAGE_ROOT / "references/triage.schema.json",
    "claim": PACKAGE_ROOT / "references/claim.schema.json",
    "evidence": PACKAGE_ROOT / "references/evidence.schema.json",
}

class CaseValidationError(Exception):
    pass


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise CaseValidationError(f"{path}: invalid JSON: {exc}") from exc


def schema_errors(value: Any, schema_key: str) -> list[str]:
    schema = load_json(SCHEMAS[schema_key])
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    problems = sorted(validator.iter_errors(value), key=lambda e: list(map(str, e.path)))
    return [f"/{'/'.join(map(str, p.path))}: {p.message}" for p in problems]


def resolve_case_ref(case_root: Path, value: str, label: str) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise CaseValidationError(f"{label}: reference must be a non-empty relative path")
    # Require portable slash-separated paths; explicitly reject Windows absolute/drive paths too.
    ref = PurePosixPath(value)
    if ref.is_absolute() or ".." in ref.parts or "\\" in value or (len(value) >= 2 and value[1] == ":"):
        raise CaseValidationError(f"{label}: unsafe/absolute reference {value!r}")
    candidate = case_root.joinpath(*ref.parts)
    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(case_root.resolve(strict=True))
    except FileNotFoundError as exc:
        raise CaseValidationError(f"{label}: referenced file does not exist: {value}") from exc
    except ValueError as exc:
        raise CaseValidationError(f"{label}: reference escapes case directory: {value}") from exc
    if not resolved.is_file():
        raise CaseValidationError(f"{label}: reference is not a file: {value}")
    return resolved


def validate_case(case_dir: Path, allow_partial: bool = False) -> dict[str, Any]:
    case_root = case_dir.resolve(strict=True)
    if not case_root.is_dir():
        raise CaseValidationError(f"case path is not a directory: {case_root}")
    errors: list[str] = []
    counts = {"capabilities": 0, "triage": 0, "claims": 0, "evidence_records": 0, "artifact_hashes": 0, "references": 0}
    required_evidence_refs: list[tuple[str, str]] = []
    recorded_artifact_paths: set[str] = set()

    caps_path = case_root / "capabilities.json"
    if not caps_path.is_file():
        errors.append("missing required capabilities.json")
        caps = None
    else:
        try:
            caps = load_json(caps_path)
            problems = schema_errors(caps, "capabilities")
            errors.extend(f"capabilities.json{p}" for p in problems)
            counts["capabilities"] += 1
        except CaseValidationError as exc:
            errors.append(str(exc))
            caps = None
        if isinstance(caps, dict):
            capability_refs: list[str] = []
            harness_info = caps.get("harness", {})
            backend_info = caps.get("backend", {})
            if isinstance(harness_info, dict) and isinstance(harness_info.get("evidence_refs"), list):
                capability_refs.extend(x for x in harness_info["evidence_refs"] if isinstance(x, str))
            if isinstance(backend_info, dict) and isinstance(backend_info.get("evidence_refs"), list):
                capability_refs.extend(x for x in backend_info["evidence_refs"] if isinstance(x, str))
            capmap = caps.get("capabilities", {})
            if isinstance(capmap, dict):
                for capability in capmap.values():
                    if isinstance(capability, dict) and isinstance(capability.get("evidence_refs"), list):
                        capability_refs.extend(x for x in capability["evidence_refs"] if isinstance(x, str))
            for ref in capability_refs:
                required_evidence_refs.append((ref, "capability snapshot"))
                try:
                    resolve_case_ref(case_root, ref, "capability snapshot evidence reference")
                    counts["references"] += 1
                except CaseValidationError as exc:
                    errors.append(str(exc))

    triage_path = case_root / "triage.json"
    triage = None
    if not triage_path.is_file():
        if not allow_partial:
            errors.append("missing required triage.json (use --allow-partial only for documented early-blocked cases)")
    else:
        try:
            triage = load_json(triage_path)
            problems = schema_errors(triage, "triage")
            errors.extend(f"triage.json{p}" for p in problems)
            counts["triage"] += 1
        except CaseValidationError as exc:
            errors.append(str(exc))
            triage = None

    # Resolve top-level references after schema checks so malformed fields are reported as schema errors too.
    if isinstance(triage, dict):
        triage_refs = triage.get("evidence_refs", [])
        refs = [triage.get("capability_snapshot_ref")]
        if isinstance(triage_refs, list):
            refs.extend(x for x in triage_refs if isinstance(x, str))
            required_evidence_refs.extend((x, "triage") for x in triage_refs if isinstance(x, str))
        for ref in refs:
            try:
                resolve_case_ref(case_root, ref, "triage reference")
                counts["references"] += 1
            except CaseValidationError as exc:
                errors.append(str(exc))
        if caps is not None and isinstance(triage.get("capability_snapshot_ref"), str) and triage["capability_snapshot_ref"] != "capabilities.json":
            # The schema supports a path; allow non-default names only if they resolve to the exact supplied snapshot.
            try:
                pointed = resolve_case_ref(case_root, triage["capability_snapshot_ref"], "triage capability_snapshot_ref")
                if pointed != caps_path.resolve():
                    errors.append("triage capability_snapshot_ref must identify the validated capabilities.json snapshot")
            except CaseValidationError:
                pass
        # Enforce cross-file routing semantics, not just the triage JSON shape.
        if triage.get("status") == "ROUTED":
            try:
                routing = yaml.safe_load((PACKAGE_ROOT / "routing.yaml").read_text(encoding="utf-8"))
                route = next((r for r in routing.get("routes", []) if r.get("id") == triage.get("route_id")), None)
                if route is None:
                    errors.append(f"triage.json: unknown route_id {triage.get('route_id')!r}")
                else:
                    if triage.get("selected_entry_skill") != route.get("entry"):
                        errors.append("triage.json: selected_entry_skill does not match routing.yaml entry")
                    if triage.get("selected_cross_check_skills") != route.get("cross_check", []):
                        errors.append("triage.json: selected_cross_check_skills do not match routing.yaml")
                    fmt = triage.get("format")
                    if not isinstance(fmt, str) or fmt.lower() not in [str(x).lower() for x in route.get("match_any", [])]:
                        errors.append("triage.json: format does not match the selected route's declared match_any tokens")
            except Exception as exc:
                errors.append(f"could not check routing.yaml consistency: {exc}")
        elif triage.get("status") == "NO_ROUTE":
            if triage.get("route_id") is not None or triage.get("selected_entry_skill") is not None or triage.get("selected_cross_check_skills") != []:
                errors.append("triage.json: NO_ROUTE requires null route/entry and an empty cross-check list")

    claims_dir = case_root / "claims"
    claim_paths = sorted(claims_dir.glob("*.json")) if claims_dir.is_dir() else []
    for path in claim_paths:
        rel = path.relative_to(case_root).as_posix()
        try:
            claim = load_json(path)
            problems = schema_errors(claim, "claim")
            errors.extend(f"{rel}{p}" for p in problems)
            counts["claims"] += 1
            if not isinstance(claim, dict):
                continue
            raw_refs = claim.get("evidence_refs", [])
            claim_evidence_refs: list[str] = list(x for x in raw_refs if isinstance(x, str)) if isinstance(raw_refs, list) else []
            refs: list[str] = list(claim_evidence_refs)
            required_evidence_refs.extend((x, rel) for x in claim_evidence_refs)
            verification = claim.get("verification", {})
            if not isinstance(verification, dict):
                verification = {}
            artifact_refs = verification.get("artifact_refs", [])
            if isinstance(artifact_refs, list):
                refs += [x for x in artifact_refs if isinstance(x, str)]
                required_evidence_refs.extend((x, rel) for x in artifact_refs if isinstance(x, str))
            cap_ref = claim.get("capability_snapshot_ref")
            if isinstance(cap_ref, str) and cap_ref:
                refs.append(cap_ref)
            resolved_paths: dict[str, Path] = {}
            for ref in refs:
                try:
                    resolved_paths[ref] = resolve_case_ref(case_root, ref, rel)
                    counts["references"] += 1
                except CaseValidationError as exc:
                    errors.append(str(exc))
            if claim.get("confidence") == "proven":
                if not refs:
                    errors.append(f"{rel}: a proven claim must reference at least one evidence artifact")
                if verification.get("status") != "passed":
                    errors.append(f"{rel}: a proven claim requires a passed verification gate")
        except CaseValidationError as exc:
            errors.append(str(exc))

    records_dir = case_root / "evidence/records"
    evidence_paths = sorted(records_dir.glob("*.json")) if records_dir.is_dir() else []
    for path in evidence_paths:
        rel = path.relative_to(case_root).as_posix()
        try:
            record = load_json(path)
            problems = schema_errors(record, "evidence")
            errors.extend(f"{rel}{p}" for p in problems)
            counts["evidence_records"] += 1
            if not isinstance(record, dict):
                continue
            try:
                content_path = resolve_case_ref(case_root, record.get("path"), rel)
                counts["references"] += 1
                recorded_artifact_paths.add(content_path.relative_to(case_root).as_posix())
                digest = hashlib.sha256(content_path.read_bytes()).hexdigest()
                if digest.lower() != str(record.get("sha256", "")).lower():
                    errors.append(f"{rel}: SHA-256 mismatch for {record.get('path')!r}")
                else:
                    counts["artifact_hashes"] += 1
            except CaseValidationError as exc:
                errors.append(str(exc))
        except CaseValidationError as exc:
            errors.append(str(exc))

    # Evidence references must point to artifacts with a validated metadata sidecar.
    for ref, owner in required_evidence_refs:
        try:
            resolved = resolve_case_ref(case_root, ref, f"{owner} evidence reference")
            normalized = resolved.relative_to(case_root).as_posix()
            if normalized not in recorded_artifact_paths:
                errors.append(f"{owner}: evidence reference {ref!r} has no matching evidence/records/*.json sidecar")
        except CaseValidationError:
            # The original unresolved-reference error was already reported above.
            pass

    result = {"case_dir": str(case_root), "status": "PASS" if not errors else "FAIL", "counts": counts, "errors": errors,
              "note": "Structural integrity only; passing does not prove analysis correctness or live harness compatibility."}
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("case_dir", type=Path, help="Case directory containing capabilities.json and triage.json")
    parser.add_argument("--allow-partial", action="store_true", help="Permit missing triage.json for documented early-blocked cases")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON result")
    args = parser.parse_args()
    try:
        result = validate_case(args.case_dir, allow_partial=args.allow_partial)
    except (CaseValidationError, OSError) as exc:
        result = {"status": "FAIL", "errors": [str(exc)]}
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"{result['status']}: case validation")
        for key, value in result.get("counts", {}).items():
            print(f"  {key}: {value}")
        for error in result.get("errors", []):
            print(f"  ERROR: {error}")
        print(f"  NOTE: {result.get('note', 'no additional note')}")
    return 0 if result["status"] == "PASS" else 1

if __name__ == "__main__":
    raise SystemExit(main())
