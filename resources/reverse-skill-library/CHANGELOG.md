# Changelog

## 3.1.0-remediated — 2026-10-21

- Resolved Module 01/Module 00 ordering conflict and WASM routing conflict.
- Added version-aware MCP modern/stateless vs legacy/handshake contract; correctly scoped Roots/Sampling/Logging deprecation.
- Made SKILL.md frontmatter metadata portable by converting custom metadata values to strings.
- Added normalized capability registry, runtime capability snapshot schema and per-harness discovery-hint adapter profiles.
- Added data-driven routing source of truth and schema-checked triage/claim/evidence contracts.
- Added authorization/trust boundaries, prompt-injection handling, worker isolation, redaction and approval invariants.
- Clarified that target-reuse absence is not proof of uniqueness and that a declaration is not a freshness retrieval.
- Added validation dependencies, automated tests, cross-platform CI, packaging exporter and compatibility matrix.
- Added performance budget, retry/idempotency, cache-key, cancellation and A/B benchmark methodology.
- Kept this as a specification library; no reverse-engineering engine or live integration is claimed.
