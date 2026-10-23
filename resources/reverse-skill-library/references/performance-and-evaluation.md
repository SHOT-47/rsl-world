# Performance, budgets, and evaluation discipline

## Optimize the real bottleneck

Do not optimize based on intuition alone. Record end-to-end wall time, model latency, tool latency, time spent waiting for approval, number of model/tool turns, input/output tokens when available, dollars/cost estimate when available, retries, peak resource usage, cache hits and correctness. Compare the same target, inputs, tool versions, policy, model settings and acceptance tests.

## Efficient execution defaults

- Progressive disclosure: load root guidance, then only the selected module and required references. Do not preload every module into model context.
- Use cheap, high-information metadata checks before expensive analysis; reuse content-addressed artifacts only when input hashes, tool versions, configuration and scope match.
- Parallelize independent read-only tasks first. Do not parallelize shared writes or side-effecting requests without idempotency and coordination controls.
- Apply bounded concurrency, wall-clock deadlines, iteration/tool-call/token/cost budgets, output-size limits, exponential backoff with jitter for transient faults, and an explicit retry allowlist.
- Distinguish transient/retryable from deterministic/permanent errors. Use idempotency keys or query-after-timeout reconciliation for side-effecting operations. Never automatically retry an operation with uncertain side effects.
- Cache only data with a sound invalidation key and data-class policy. Do not cache credentials or sensitive raw payloads in unprotected stores.
- Make cancellation observable and wait for workers/tools to reach a known terminal state; cancel orphaned subprocesses and release temporary resources.

## Evaluation gates

Maintain versioned fixtures for route selection, capability fallback, schema validation, target-reuse uncertainty, evidence promotion, prompt injection, secret redaction, MCP legacy/modern lifecycles, timeout/cancellation, checkpoint recovery, export packaging and no-route handling.

Use deterministic assertions for structural invariants and rubric/model-based scoring only for judgment-heavy outcomes. Store traces and input fixture versions. Compare outcome quality and efficiency separately; a faster run that loses required evidence is a regression.

No performance claim is valid without repeated same-workload A/B measurements, a baseline, sample size, median and tail latency, token/cost impact, correctness/evidence parity, and noted environmental differences. Do not infer performance from fewer instructions or concurrent workers alone.
