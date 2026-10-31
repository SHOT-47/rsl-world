# Testing and release gates

## Local test commands

- `node --test tests/*.test.mjs` — JavaScript security/source-contract tests.
- `node --experimental-strip-types --test tests/*.test.ts` — TypeScript runtime/unit/contract tests using Node 22's type stripping; this is not a semantic typecheck.
- `python -m unittest discover -s tests -p 'test_schema.py' -v` — SQLite schema/migration tests using Python's SQLite engine.
- `python resources/reverse-skill-library/validation/check_library.py` — RSL structural/schema checker.
- `python -m unittest discover -s resources/reverse-skill-library/validation -p 'test_*.py' -v` — RSL regression suite.
- `node scripts/check_typescript_syntax.mjs` — TypeScript/TSX syntax transpilation. Not a semantic typecheck.
- `python scripts/verify_structure.py` — cross-file structure/security/persistence/package assertions.
- `npm run typecheck` / `npm run build` — strict semantic TypeScript check and Electron/Vite build after dependencies are installed.
- `npm run package:win` — validation plus Windows NSIS packaging; run on Windows.

## Covered test areas

1. **Electron security contracts:** renderer preferences, CSP, navigation, sender validation, named preload API and no raw shell IPC.
2. **Policy:** risk tiers, hard-deny, workspace path handling, network host rules, exact approval hash and secret redaction.
3. **Provider diagnostics/chat:** mock-server model discovery, safe authentication failure messages, TLS/URL/DNS policy, blocked redirects, response caps and tool-call parsing.
4. **Credential store:** OS encryption abstraction, fail-closed behavior, active provider metadata and no decrypted secret in summaries.
5. **Python worker:** versioned request/response IDs, workspace membership, hash, secret redaction, path traversal/symlink denials, cancellation and timeout/released capacity.
6. **Task service/state/schema:** registered roots, bounded inputs, transactional schema constraints, checkpoint hash/version, interrupted/uncertain recovery and one-shot approval semantics.
7. **Tool broker and coding-agent loop:** bounded workspace file tools, write preview, atomic write, no shell execution, command/time/output limits, checkpoint hooks, uncertain side effects and close/cancel lifecycle.
8. **RSL preflight/index:** parsing of the public index, local-only query matching, secret-term removal, URL validation, cache checksum/TTL/ETag, refresh failures, consent/review gates, bundled route resolver and case validator.
9. **Target API:** explicit authorization, relative-path checks, public DNS pinning, GET-only/no-auth/no-redirect, response-size bounds, JSON-aware redaction, evidence persistence and uncertain timeout behavior.
10. **RSL library:** package checker, case-validator failure paths, evidence hash/reference/drift tests and export smoke tests for all ten declared profiles.
11. **Context Intelligence:** model-capacity budgeting, low-confidence shadow token estimates, provider usage reconciliation, protected-context selection, provenance checks, tool-call/result pairing, reversible cleanup proposals, duplicate handling and unsafe-boundary blocking.

## Verified offline results for v0.2.0-dev

Each suite below completed independently; the counts should not be interpreted as one aggregate command succeeding:

- **82 TypeScript runtime/unit/contract tests passed**, including 13 Context Intelligence tests and two native `TaskStore` snapshot/restore integration tests.
- **9 JavaScript source-contract tests passed.**
- **10 SQLite schema tests passed** using Python's SQLite engine, including migration 007 context-ledger/snapshot constraints (not a native `better-sqlite3` TaskStore integration test).
- **37 RSL regression tests passed.**
- **16 browser architecture structural/security assertions passed.**
- **370 RSL static/schema assertions passed**; 20 Agent Skills manifests, 19 module files, 10 adapter profiles, 31 capability categories, 10 routes, 8 freshness feeds, 18 YAML and 6 JSON files parsed/validated.
- **Strict TypeScript typecheck passed** and **Vite browser asset build passed** in GitHub Actions.

Total passed executable tests in CI: **138** (82 TypeScript + 9 JavaScript + 10 SQLite schema + 37 RSL). Structural assertions are additional and are not counted as executable tests.

## Not verified here

GitHub Actions ran `npm ci`, browser static checks, `npm test`, strict `npm run typecheck` and `npm run build` successfully on the implementation branch. The SQLite schema suite uses Python's SQLite engine, and native `TaskStore` append/propose/activate/restore/gate integration tests also pass. Full crash/restart recovery across all context lifecycle boundaries remains unverified. No live provider call, model-specific tokenizer/preflight integration, commercial coding-agent/MCP conformance, adversarial red-team, hostile binary sandbox test or controlled performance benchmark has run. Token Assist currently uses a low-confidence heuristic in shadow mode because no verified per-model context/tokenizer profile is wired into provider configuration. Cleanup Loop creates deterministic proposals; TaskStore persists hash-checked ledger records and proposed/active snapshots, but proposal-to-activation is not yet wired into the live agent lifecycle. Source records are append-only and are not deleted by cleanup.

## Required before public/production release

- Install pinned dependencies on a network-enabled Windows host and generate/commit a deterministic lockfile; verify package integrity.
- Run strict typecheck, full CI matrix, Electron launch, database migrations/recovery, Windows safeStorage and NSIS installer smoke tests.
- Exercise database migrations and crash/restart at every task transition and side-effect window.
- Live probe each adapter and supported version; record feature-specific evidence rather than extrapolating compatibility.
- Exercise versioned MCP lifecycle/primitive negotiation, and integrate/test REA/GhidraMCP only where the selected version supports them.
- Red-team commands, network, credentials, prompt injection, path/reparse-point handling, worker cancellation and updates. Add OS-level sandboxing before running untrusted code or binaries.
- Benchmark a fixed RSL/coding corpus against baseline and changes; report median/p95 latency, cost/tokens, memory, completion quality and evidence completeness. Make no speedup claim without repeatable results.
