# Project graph

## N01 — Secure desktop shell and interface contracts
- goal: Establish Electron + React + TypeScript structure, hardened window settings, typed preload API and renderer-only UI.
- status: VERIFIED_SOURCE_CONTRACTS (7 security tests; syntax transpilation includes renderer/preload; Electron runtime not built).

## N02 — Orchestration, persistence and checkpoint resume
- goal: Bounded task lifecycle, event stream, local SQLite metadata, hash-checked checkpoints and cautious resume.
- status: VERIFIED_UNIT_AND_SCHEMA (task/state/policy/tool/runtime tests plus 8 SQLite schema tests; native better-sqlite3 integration not run).

## N03 — Python worker integration
- goal: Managed JSON-lines worker with timeout/cancel/error handling, path guard and bounded concurrency/output.
- status: VERIFIED_UNIT_TESTS (8 worker-focused tests; subprocess contract test, not OS sandbox proof).

## N04 — RSL library import and case/evidence verification
- goal: Bundled upgraded RSL package, validator, case validator and exporter with evidence/path/hash checks.
- status: VERIFIED_OFFLINE_TESTS (370 library checker assertions and 37 regression tests; deterministic preflight runtime integration is implemented; specialist execution remains gated).

## N10 — RSL preflight and prior-art index
- goal: Capabilities-first preflight, local query matching against public awesome-reverse-engineered index, candidate acknowledgment, RSL routing, provenance and case validation.
- status: SOURCE_AND_MOCK_TESTED (6 index tests plus RSL workflow tests; public protocol is mock-tested, no live in-app HTTP or specialist reverse engineering).

## N11 — Explicit-scope Target API workflow
- goal: Main-process consent, bounded unauthenticated GETs, destination/DNS controls, redaction and evidence persistence.
- status: SOURCE_AND_MOCK_TESTED (target API regression tests; no auth, crawling, mutations or passive proxy import).

## N05 — UI vertical slice and automated checks
- goal: Chat-first workbench for projects, tasks, approvals, activity, providers, RSL manager and evidence.
- status: SOURCE_AND_CONTRACT_TESTED (69 TypeScript runtime/unit tests; 35 files syntax-transpiled; no dependency-backed GUI build/startup).

## N06 — Windows package and native-runtime verification
- goal: Produce lockfile, typecheck, build, launch on Windows, exercise safeStorage/SQLite, and build NSIS installer.
- status: BLOCKED_ON_WINDOWS_AND_NPM_DEPENDENCIES.
- depends_on: N01,N02,N03,N04,N05

## N07 — End-to-end RSL specialist execution
- goal: Compose and execute specialist modules with evidence gates and independent verification after preflight.
- status: PARTIAL; RSL deterministic preflight/routing/case validation is implemented, specialist analysis is not.
- depends_on: N04,N06

## N08 — Live MCP / REA / GhidraMCP / agent adapter conformance
- goal: Versioned clients, capability probes, real version-specific tests across selected coding-agent runtimes.
- status: NOT_LIVE_TESTED. Exported agent profiles are not runtime certification.
- depends_on: N04,N06

## N09 — Security and performance release gates
- goal: OS-level execution isolation, adversarial testing, recovery crash matrix, redaction recall, deterministic corpus benchmarks.
- status: NOT_COMPLETE.
- depends_on: N06,N07,N08

## Latest verification
- TypeScript/TSX syntax transpilation: PASS, 35 files; syntax check only, not semantic typecheck.
- Workbench static guard: PASS, 48 structural/security/persistence/package assertions.
- Independently completed executable suites: 9 JavaScript tests + 69 TypeScript tests + 8 SQLite schema tests + 37 RSL regression tests = 123 passed, zero individual test failures.
- RSL checker: PASS, 370 static/schema assertions; 20 skills manifests, 19 modules, 10 adapters, 31 capability categories, 10 routes and 8 feeds.
- Target-reuse public index behavior/cache and Target API controls are mock-tested; no real in-app live requests are claimed.
- npm registry was unreachable; no `node_modules`, package lock, semantic typecheck, Electron build, GUI start, native `better-sqlite3` binding test or Windows installer is claimed.
