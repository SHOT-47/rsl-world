# PRD 3.1 Remediation Addendum

**Applies to:** supplied Reverse Skill Library PRD v3.0 and `reverse-skill-library.zip`.  
**Purpose:** resolve contradictions and add enforceable contracts. This addendum does not silently rewrite the user's source PRD; for the upgraded package, these clarified rules supersede conflicting v3.0 statements.

## Normative corrections

1. **Control order:** scope/trust boundary → Module 01 capability detection → Module 00 target reuse → Module 02 triage → selected modules → Module 15 packaging. The PRD's §5.1 statement that Module 01 runs after Module 00 conflicts with §3.2 and the root `SKILL.md`; Module 01 first is the authoritative rule.
2. **Routing:** `routing.yaml` is the single machine-readable source. Managed .NET/JVM bytecode routes to Module 07; WASM/WebAssembly routes to Module 11. The old table incorrectly grouped WASM with Module 07 while also advertising a WASM specialist in Module 11.
3. **Agent Skills metadata:** frontmatter `metadata` values must be strings, as required by the portable Agent Skills format. RSL-specific requirements are encoded as strings such as `metadata.rsl-requires: "01-detect-capabilities,02-re-triage"`, not YAML arrays nested under metadata.
4. **Agent compatibility semantics:** adapter YAML values are discovery hints. Static profiles do not prove active-version support. The canonical observed state is `available`, `partial`, `unavailable`, or `unknown`, attached to a detection method, evidence reference and fallback state. E2E compatibility requires in-product tests.
5. **MCP lifecycle:** detect the protocol version/era. MCP `2026-07-28` is stateless and uses `server/discover` rather than the legacy `initialize` handshake. `2025-11-25` and earlier use the handshake. Roots, Sampling and Logging are deprecated in the `2026-07-28` specification but may remain functional during its deprecation window and in older versions. New workflows must not depend on them; adapters must not call them universally absent.
6. **Target-reuse claims:** replace `confirmed-unique` with `no_match_found_in_searched_sources`; a finite search cannot prove global uniqueness. `TARGET_ALREADY_SOLVED` requires a documented fit matrix, provenance, and material gaps.
7. **Evidence:** epistemic status and confidence are independent dimensions. `proven` requires linked evidence and a passed verification gate with verifier/timestamp; an artifact path alone is insufficient.
8. **Security:** establish authorized scope, treat target/tool/retrieved content as untrusted data, isolate potentially hostile samples, enforce path/network/credential boundaries, redact before persistence, and prohibit unsafe out-of-scope actions.
9. **Freshness:** feed registry declarations do not mean feeds were fetched. Currentness requires observed URL, UTC retrieval timestamp, source/version identifier, status and hash/version where feasible. Failed or missing sources are degraded.
10. **Verification:** Markdown `validation/specs/*.md` files are scenario specifications, not executable tests. Package CI must run parsing/schema/contract/regression tests; live integration tests remain separately required to establish compatibility with real agent versions and external backends.
11. **Optionality:** Module 18 is an optional, proposal-first self-improvement workflow; no automatic self-modification. Module 17 is documented as part of RSL but delegated execution is capability-gated and must fall back sequentially.
12. **Performance:** load modules progressively; bound concurrency/time/tool calls/tokens/cost; measure same-workload correctness and performance; don't claim speedup without repeatable A/B results.

## Compatibility target

RSL targets a portable Agent Skills core plus capability-gated integrations. It does not promise that all ten harnesses expose identical hooks, permissions, subagents, resumability, model-routing or MCP semantics. A missing feature must be detected, explicitly degraded with a fallback, or block the dependent operation. No unsupported feature is silently emulated as if native.
