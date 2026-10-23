# Evidence and claim contract

## Two independent labels

`epistemic_status` records how the proposition is known: `confirmed_fact`, `inference`, or `unknown`. `confidence` records the verification level: `proven`, `strongly_inferred`, `inferred`, or `unverified`. These axes are not interchangeable; `confirmed_fact` alone does not mean a claim is proven.

## Claim-level minimum

Every material conclusion must have a stable claim ID, exact statement, epistemic status, confidence, one or more artifact references when available, a verification gate/status, capability snapshot reference and explicit limitations. When evidence is absent, use inference/unknown and lower confidence instead of fabricating a link.

A claim may use `confidence=proven` only if:

1. At least one resolvable evidence artifact is linked.
2. The required target-specific verification gate passed.
3. The verifier and UTC timestamp are recorded.
4. Evidence points to the actual target/build/version/test fixture in scope.
5. Known limitations do not contradict the claim.

Static analysis can establish a static property; it does not alone establish runtime reachability, exploitability, semantic equivalence, or performance improvement.

## Evidence artifact minimum

Record stable artifact ID/path, SHA-256, UTC creation time, source type/locator, tool names and exact versions, bounded/redacted invocation parameters, redaction state, scope, limitations, parent inputs, and relevant capability snapshot. Hash the persisted artifact bytes; if a source is remote, persist an authorized, bounded capture or canonical representation and state exactly what was hashed. Preserve raw and transformed artifact relationships when authorized. A redacted artifact must not be represented as a byte-identical original.

All `evidence_refs`, `artifact_refs`, `capability_snapshot_ref`, and evidence-record `path` values are relative to the case directory (for example, `evidence/static/analysis.txt` or `capabilities.json`). Absolute paths, drive-qualified paths, `..` traversal and symlink/junction escapes are invalid. `evidence/records/*.json` holds metadata sidecars; their `path` identifies the content artifact whose SHA-256 must match.

## Freshness

A feed is current only with a successful retrieval record containing exact URL, retrieval timestamp, source/version identifier, status and content/version hash where feasible. A registry declaration, stale cache, failed network call, or search result snippet is not a fresh source. Any required missing feed yields `freshness_status=degraded`.

## Honest terminal reporting

Report `passed`, `failed`, `blocked`, `skipped`, `not_run` and `degraded` distinctly. Do not convert unavailable tool capability or missing evidence into success. Report what remains unverified and what would close the gap.
