# RSL v3.1 Remediation — Validation Results

**Run date:** 2026-10-21 (research/report date)  
**Scope:** offline validation of the upgraded specification library and synthetic case fixtures.  
**Environment observed:** Python 3.13.5, PyYAML 6.0.3, jsonschema 4.26.0.  
**Important:** this is not a live product compatibility certification or reverse-engineering correctness test.

## Results

| Check | Observed result | Meaning |
|---|---:|---|
| `python validation/check_library.py` | PASS | 370 static/schema assertions; parsed 18 YAML and 6 JSON files; validated 20 Agent Skills manifests, 19 modules, 10 adapter profiles, 31 capability categories, 10 routing entries, and 8 freshness feeds. |
| `python -m unittest discover -s validation -p "test_*.py" -v` | PASS | 37 unit/contract tests; final source-copy test-runner time 0.552 s (shell wall time varies by environment). |
| Adapter exporter test | PASS | Exported all 10 configured harness profiles to one-skill packages; verified nested module renaming, manifest flags, relative references and no-overwrite behavior. |
| ZIP artifact extraction + validation | PASS | Re-extracted the delivered package archive, reran the 370-assertion checker and all 37 unit/contract tests successfully. |
| Case validator CLI on synthetic fixture | PASS | 1 capability snapshot, 1 triage, 1 claim, 3 evidence sidecars, 3 artifact hashes and 9 references validated; no errors. |
| Negative fixtures | PASS | Rejected a fake `proven` claim, invalid hash, evidence path traversal, missing evidence sidecar, triage/routing drift and malformed capability JSON. |
| Current adapter-profile contract tests | PASS | Verified Cursor Agent Skills paths, Grok documented skill/hooks/subagents/MCP status without runtime-certification, Windsurf/Devin docs transition, and separation between Codex CLI/API docs. |
| CI workflow | CONFIGURED, NOT RUN HERE | Workflow defines Ubuntu/Windows × Python 3.10/3.12; only the local Python 3.13.5 environment was executed in this session. |

## What the test results prove

They prove that the upgraded package parses, selected schemas validate, routing references and declared output keys are internally consistent, confidence/evidence contracts reject the tested invalid states, adapter exports are structurally formed, and the synthetic case validator handles the tested safe/unsafe paths and hashes.

## What the results do not prove

- Actual skill discovery, hook execution, approval enforcement, subagent isolation, cancellation, streaming, checkpoint recovery or model-routing semantics inside each of the 10 real agent products.
- REA/GhidraMCP live compatibility, a real binary analysis outcome, accuracy of reverse-engineering conclusions or freshness of a feed that was not fetched.
- Prompt-injection resistance under red-team attack, sandbox strength, perfect secret-redaction recall, crash-safe recovery in the future Workbench runtime, or measured speedups.
- Cross-platform success until the configured GitHub Actions matrix actually runs.

## Release gate

Do not describe RSL as “10/10 certified” or universally compatible from these offline results alone. Before release, run the scenarios in `COMPATIBILITY_TEST_PLAN.md` for each claimed harness/version/backend, add adversarial security tests, and publish repeatable same-workload A/B performance results with correctness/evidence parity.

### Artifact-level smoke test

A real invocation of `validation/export_skill.py --harness cursor --dest <temporary-directory>` exported the package successfully. An independent post-export assertion verified exactly one `SKILL.md`, presence of `MODULE.md` for nested modules, and manifest fields `runtime_verified: false` / `installed_into_harness: false`. Output: `PASS: real CLI export smoke test`.
