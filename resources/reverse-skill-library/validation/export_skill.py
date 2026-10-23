#!/usr/bin/env python3
"""Export RSL as one portable Agent Skills package without modifying the source."""
from __future__ import annotations
import argparse
import json
import re
import shutil
from pathlib import Path
import yaml

ROOT = Path(__file__).resolve().parents[1]


def export_skill(harness: str, dest: Path, source_root: Path = ROOT) -> Path:
    adapter_path = source_root / "agents" / f"{harness}.yaml"
    if not adapter_path.is_file():
        raise ValueError(f"unknown harness profile: {harness}")
    adapter = yaml.safe_load(adapter_path.read_text(encoding="utf-8"))
    output = dest / "reverse-skill-library"
    if output.exists():
        raise FileExistsError(f"refusing to overwrite existing output: {output}")
    dest.mkdir(parents=True, exist_ok=True)
    try:
        shutil.copytree(source_root, output, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store"))
        # Nested module SKILL.md files are supporting docs in the exported one-skill bundle.
        module_dir = output / "modules"
        for nested in module_dir.glob("*/SKILL.md"):
            nested.rename(nested.with_name("MODULE.md"))
        # Rewrite references inside text resources to the renamed support files.
        for p in output.rglob("*"):
            if not p.is_file() or p.suffix.lower() not in {".md", ".yaml", ".yml", ".txt"}:
                continue
            try:
                raw = p.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue
            fixed = re.sub(r"(modules/\d{2}-[a-z0-9-]+)/SKILL\.md", r"\1/MODULE.md", raw)
            if fixed != raw:
                p.write_text(fixed, encoding="utf-8")
        (output / "EXPORT.json").write_text(json.dumps({
            "schema_version": "1.0",
            "package": "reverse-skill-library",
            "profile": harness,
            "exported_only": True,
            "installed_into_harness": False,
            "runtime_verified": False,
            "suggested_discovery_paths": adapter["harness"]["discovery_hints"]["skill_paths"],
            "required_next_step": "Follow the product's current official installation instructions and verify skill loading in the installed harness/version."
        }, indent=2) + "\n", encoding="utf-8")
        # Export is valid only if the root skill survived and nested modules no longer resemble skill manifests.
        if not (output / "SKILL.md").is_file():
            raise RuntimeError("export missing root SKILL.md")
        nested_skills = list((output / "modules").glob("*/SKILL.md"))
        if nested_skills:
            raise RuntimeError(f"nested module SKILL.md files remain discoverable: {nested_skills}")
        return output
    except Exception:
        shutil.rmtree(output, ignore_errors=True)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--harness", required=True, choices=sorted(p.stem for p in (ROOT / "agents").glob("*.yaml")))
    parser.add_argument("--dest", required=True, type=Path, help="Parent directory; exporter creates reverse-skill-library inside it")
    args = parser.parse_args()
    try:
        output = export_skill(args.harness, args.dest)
    except (ValueError, FileExistsError, RuntimeError) as exc:
        parser.error(str(exc))
    print(f"EXPORTED: {output}")
    print("NOT INSTALLED: follow the selected harness's official instructions and run an in-product load test.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
