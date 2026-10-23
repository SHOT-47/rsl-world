# RSL Brutal Audit — baseline and remediation

**Audit scope:** supplied `PRD.txt` (RSL v3.0) and `reverse-skill-library.zip` (59 entries, 73,624 uncompressed bytes).  
**Baseline checker result:** `python validation/check_library.py` passed before changes. This only proved that the original string-based checks passed.  
**Baseline assessment:** approximately **4/10 for production-grade cross-agent reliability**; a reasoned engineering judgment, not a benchmark. The central concept was good, but the original assurance model was materially weaker than its claims.

**Remediated assessment:** approximately **8/10 for specification quality and offline contract coverage**, and **not yet production-certified** for live cross-agent compatibility. The remaining gap is empirical: this repository is a skills/workflow specification, not the Workbench runtime or the reverse-engineering engine. A 10/10 claim would be dishonest without real harness/backend execution, adversarial tests and same-workload performance measurements.

## Critical findings

| ID | Severity | Finding | Why it matters | Remediation in v3.1 package | Verification |
|---|---|---|---|---|---|
| RSL-001 | P0 | Conflicting execution order in PRD: §3.2 says capability detection → target reuse → triage, while §5.1 says Module 01 runs after Module 00. | Different harnesses may run prior-art searches before capability detection, violating the blocking preflight contract. | PRD addendum and root skill set Module 01 first; target reuse follows. | CI contract test checks ordering. |
| RSL-002 | P0 | WASM routed inconsistently: PRD/root/module table routes bytecode/WASM to Module 07 while Module 11 is also the WASM specialist. | Routing is non-deterministic or sends analysis into a semantically wrong workflow. | Added `routing.yaml` as sole source of truth; WASM goes to Module 11, .NET/JVM to 07. | Route fixtures, module-id validation, deterministic route tests. |
| RSL-003 | P0 | MCP lifecycle assumed to be a handshake even for version `2026-07-28`. | The modern protocol uses stateless per-request lifecycle and `server/discover`; an initialize-only client can fail against modern servers. | Added version/era-aware `backend/mcp-compatibility.yaml`; updated module 01 and backend manifests. | Tests validate modern vs legacy lifecycle metadata. |
| RSL-004 | P1 | Agent Skills frontmatter stores `metadata.requires` as a YAML list, while portable Agent Skills metadata is a string-to-string map. | Strict/portable harness parsers may reject or ignore nonconformant metadata. | Converted RSL metadata to strings (`rsl-requires`, `rsl-module-id`, `rsl-optional`). | YAML/frontmatter/schema tests. |
| RSL-005 | P1 | Original validation corpus largely consisted of Markdown test specifications; only a brittle checker was executable. | Passing the checker did not execute routing determinism, claim promotion, fallback, freshness, or end-to-end scenarios. | Added Python unit/contract tests, JSON Schemas, fixtures, exporter tests and CI. | Full offline suite and checker executed on upgraded copy. |
| RSL-006 | P1 | Checker used regex rather than full YAML parsing and could pass semantically malformed YAML/adapter values. | Broken configuration can look structurally correct. | YAML parse and schema validation with explicit test dependencies; normalized adapter schema. | Negative fixture tests and full parse pass. |
| RSL-007 | P1 | Static adapter files assert booleans and paths but had no source/version provenance and no distinction between support claims and runtime observations. Some paths/event names were fragile or unsupported. | False compatibility claims cause silent loss of hooks, MCP, subagents or rules. | Adapter profiles now label discovery hints, attach docs URLs, use `probe_required` states and specify runtime test requirements. | Adapter contract validation; ten export packaging tests. Live E2E remains outstanding. |
| RSL-008 | P1 | Target-reuse flow could report `confirmed-unique` from a finite search. | Absence of evidence was promoted to an unsupported universal claim. | Replaced with `no_match_found_in_searched_sources` plus query/scope/timestamp and limitations. | Regression scan and target-reuse spec update. |
| RSL-009 | P1 | “Proven” claims required linked evidence textually, but there was no machine-readable enforcement of a passed verification gate, verifier and time. | A path could be attached to a claim without proving that required validation ran or passed. | Added claim schema with conditional `proven` requirements and evidence schema. | Schema tests accept/reject representative claims. |
| RSL-010 | P1 | Explicit threat model for prompt injection in target-derived/tool/retrieved content and for untrusted package/skill supply chain was missing from the core contract. | Embedded instructions could influence a model to exceed scope or bypass gates; untrusted sample execution can damage the environment. | Added central trust-boundary, authorization, isolation, output validation, secret redaction and approval invariants. | Structural safety invariant tests; dynamic red-team runs are still needed. |
| RSL-011 | P1 | Freshness feeds described source names and TTLs but frequently lacked resolvable locators and required retrieval records. | The library could declare feeds “fresh” without proving any fetch happened. | Added locator/retrieval strategy, required retrieval fields and explicit `fetching_implemented_here: false`. | Feed schema/field tests. |
| RSL-012 | P2 | Routing and capability definitions were spread between PRD, root skill, module prose and YAML, causing drift. | A correction in one place can leave another place stale. | Canonical `routing.yaml`, machine-readable contracts and PRD addendum clarify precedence. | Link/dependency and content consistency tests. |
| RSL-013 | P2 | No explicit operational performance budget/retry/cache methodology. | Parallelism can increase costs or duplicate side effects, while token savings can weaken evidence. | Added budgets, bounded concurrency, idempotency/reconcile-after-timeout, cache-key and same-workload benchmark rules. | Contract presence tests; real performance still requires benchmarks. |
| RSL-014 | P2 | Package did not provide a safe export path and nested module `SKILL.md` files could be discovered as independent skills. | Exported skill paths may break relative references or load extra skills unintentionally. | Added exporter that creates a portable one-skill package, renames nested module files to `MODULE.md`, rewrites references and refuses overwrites. | Export tests for all ten profiles. |
| RSL-015 | P2 | Module optionality and support boundaries were imprecise; static package cannot promise live feeds, analysis execution or full cross-agent feature parity. | Users can interpret documentation as implemented runtime capability. | README/PRD addendum state the package limits and separates package checks from integration conformance. | README/addendum and test contract. |

## Remediation approach

- Keep the existing 19-module content and directory IDs to preserve the package's shape.
- Add schemas and machine-readable contracts instead of attempting to make the skill text an execution engine.
- Preserve all ten requested harness profiles but demote unverified native claims to discovery hints.
- Make security, evidence and performance rules reusable by all modules.
- Introduce executable offline regression tests while clearly leaving product-specific E2E to environments with those products installed.

## What passed after remediation

See `validation/RESULTS.md` and the standalone validation results JSON. They record the actual commands and observed outcomes for this run. Final suite counts are regenerated after every last-minute source change; results must not be copied forward from earlier runs.

## What remains unproven

- Ten real harnesses have not been installed or E2E-tested here.
- REA/GhidraMCP handshakes and actual tool catalogs were not connected/tested.
- No target binary or real case was analyzed; no claim of reverse-engineering correctness is made.
- Prompt-injection robustness, sandboxing, redaction recall, checkpoint crash recovery, and performance gains require integration/red-team/benchmark runs in the real Workbench runtime.
- Adapter documentation links should be validated again before release because product paths can change. Cursor and Grok Build profiles were refreshed against current official docs; Windsurf's former docs hostname currently redirects to Devin Desktop docs, so the profile is deliberately marked legacy/transition. Codex API/plugin docs and Codex CLI features are not treated as interchangeable.

**Verdict:** the upgraded library has stronger contracts and meaningful automated package validation. It is not honestly certifiable as “10/10” or universally compatible until the outstanding live E2E and performance gates pass.
