# Feature status

| Feature | Status | Evidence / limitation |
|---|---|---|
| Context Intelligence (Cleanup Loop + Token Assist) | Initial backend primitives implemented; shadow mode only | Token Assist records low-confidence request estimates and reconciles provider prompt usage; deterministic cleanup proposals and hard context audits are available. TaskStore now persists append-only, hash-checked context records and proposed/active versioned snapshots. Automatic task-loop compaction, verified tokenizer profiles and browser-preview execution are not enabled. |
| Electron + React secure shell | Source implemented; runtime build pending | Source contract tests pass; dependencies unavailable for launch/build |
| Typed IPC + sandboxed renderer | Implemented in source | 7 source contract tests; still needs real Electron integration test |
| Local project/session database | Implemented in source | 6 migrations and 8 schema tests; native `better-sqlite3` binding not run here |
| Checkpoint and safe resume | Implemented for coding task state | Unit tests; restart/crash E2E not yet run |
| Provider settings + encrypted key persistence | Implemented in source | Store unit tests; Windows `safeStorage` requires Windows runtime test |
| OpenAI-compatible provider diagnostics | Implemented/tested using local mocks | No live provider calls in audit; provider support varies |
| OpenAI-compatible coding-agent loop | Implemented as first slice | Mock-server tests + tool broker tests; no full E2E with Electron GUI |
| File read/list/search tools | Implemented and bounded | Unit tests; host filesystem ACLs still apply |
| File write with exact approval | Implemented | Unit tests; only redacted bounded content preview is persisted |
| Command execution with exact approval | Implemented with direct argv, no shell | Unit tests; no OS sandbox, runs with user privileges; production gate |
| Python worker protocol/supervisor | Implemented | Unit tests; subprocess isolation only, no OS sandbox |
| RSL package validation/case validation/export | Implemented | Bundled validator/tests and 10 profile export checks pass |
| RSL preflight investigation task mode | Implemented for deterministic preflight | Target-reuse index lookup, candidate approval, capability snapshot, routing and bundled case validation; specialist modules are not executed |
| Target API investigation | Implemented for explicit read-only GET scope | Consent-gated, no auth/cookies/redirects/crawling; response/evidence persisted with redaction; passive observed-traffic capture remains absent |
| Native MCP client and REA/GhidraMCP | Not integrated | Needs protocol-versioned client plus live conformance/security tests |
| Ten coding-agent runtimes/hooks | Profile/export support only | No claim of runtime certification; live per-agent tests outstanding |
| Automatic cross-provider/local→cloud fallback | Disabled | Manual choice only by architecture decision |
| Windows installer | Not built in current environment | Registry timeout prevented dependency installation; run package script on Windows |
| awesome-reverse-engineered index integration | Implemented with local query matching and verified 24-hour cache | Fixed HTTPS data endpoint, 12 MiB cap, TLS/DNS pinning/no redirects, SHA-256 cache integrity, ETag revalidation; source is public CC0 data |
| Performance improvements | Design bounds present; benchmark pending | Cache avoids repeat downloads for 24 hours and uses conditional HTTP revalidation; no end-to-end latency speedup claim without benchmarks |
