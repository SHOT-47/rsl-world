# Architecture

## Process model

- **React renderer:** chat, plans/tasks, approval review, provider configuration, RSL management, events and evidence view. It has no direct Node or filesystem privileges.
- **Electron main:** validates IPC senders; owns task lifecycle, SQLite persistence, provider/key access, policy decisions, task orchestration and application lifecycle.
- **Preload:** narrow typed `contextBridge` API with enumerated methods and data contracts. There is no generic channel or command execution method exposed to the renderer.
- **Python child workers:** receive a versioned JSON request contract; reject unregistered roots and out-of-workspace paths; cap concurrency, input/output and execution time; report structured outcomes. These are process-isolated but not OS sandboxed.
- **Local SQLite:** task and project metadata, immutable checkpoint versions with SHA-256 integrity, event records, approval grants, provider metadata and evidence metadata. Files referenced by evidence remain in the project tree.
- **RSL bundle:** version-pinned under `resources/reverse-skill-library`. It is the source of truth for RSL routes and workflow specifications; runtime code should not silently replicate its routing table.

## Main path: bounded coding task

1. User selects/registers a project root and creates a coding task.
2. Task/prompt is validated and likely secrets are redacted before persistence.
3. Runtime checks active provider and loads an integrity-checked checkpoint.
4. A bounded OpenAI-compatible conversation runs with a tool allowlist, turn/tool/wall-time/transcript bounds and cancellation.
5. Read tools canonicalize paths and bound results. Writes/commands are classified by central risk policy, previewed, hashed, and authorized through a one-time exact-action approval.
6. Before a side effect, the checkpoint marks it in flight. The result and its conversation record are durably checkpointed before the operation is considered safely complete. Recovery never blindly retries a possibly executed side effect.
7. Completion/failure/cancellation is written to local task state and activity log. Uncertain side effects require reconciliation.

## Policy hierarchy

Global hard-deny and risk rules are non-overridable. Project roots define the filesystem boundary. Tool and provider adapters must invoke the same policy and logging contracts. An approval is bound to the exact operation serialization/hash, expires, is single-use and is revalidated immediately before consumption.

## RSL target-reuse preflight

Before triage, the RSL workflow builds a conservative query from the task title after heuristic redaction and sensitive/high-entropy term removal. It fetches the fixed public `https://awesome.alexgaoth.com/data.json` dataset only when the verified local cache is older than 24 hours. The title-derived terms are matched on-device; they are not appended to the URL or transmitted as a search query. The request uses the shared DNS/IP safety checks, pinned address, valid TLS, no redirects, a 12 MiB cap and a 15-second timeout. The dataset schema and result URLs are validated before caching. A SHA-256 checksum catches accidental cache corruption; it is not a signature and does not protect against a same-user attacker who can rewrite both cache and digest.

Fresh caches avoid network traffic. Stale caches use ETag/Last-Modified conditional requests when available. Candidates are ranked by local lexical matches, with popularity used only as a tie-breaker. Fit remains `not_assessed` until a user reviews candidates; candidate code is neither cloned nor executed. Zero results means no match in this index snapshot, not proof of uniqueness. Source: https://github.com/alexgaoth/awesome-reverse-engineered. The project identifies scripts as MIT-licensed and index data as CC0 1.0.

## Target API workflow

A target investigation requires a normalized explicit base URL, at most ten listed relative paths and both renderer acknowledgement and a native main-process consent dialog. Only unauthenticated GET is supported. Remote targets must use public HTTPS DNS; local HTTP is limited to loopback. Each request is pinned to the vetted address, redirects are not followed, response size and wall time are bounded, and no automatic discovery/crawling is performed. Likely secrets are redacted before response persistence; capture hashes describe the redacted persisted bytes, not an original raw response. A transport timeout is recorded as an uncertain outcome and stops the remaining path sequence to avoid unsafe retries. Passive browser/proxy capture and authenticated target calls are not included.

## Model adapter

The current adapter supports the OpenAI-compatible `/models` diagnostic endpoint and chat-completions-style tool calls. Local models must listen on loopback by default. Cloud endpoints must be HTTPS, resolve to public addresses, and are pinned to the vetted DNS result per request; TLS certificate verification is enabled and redirects are not followed. Responses and request durations are bounded. Provider selection is explicit; local failure does not trigger cloud fallback.

This adapter is not a universal LLM protocol. Native Anthropic/Gemini/etc. APIs, multimodal APIs and non-OpenAI tool calling need separate adapters and per-capability conformance tests.

## Lifecycle and recovery

Window close asks the user whether to stop active work, keep it in the tray/background, or cancel closing. Safe quit requests cancellation and waits for runtime completions before closing SQLite. If that wait times out, Workbench stays open to avoid racing checkpoint writes. On restart, interrupted work is classified from checkpoint plus side-effect state; pending approvals expire. A possible side effect becomes `outcome_uncertain` and is not auto-replayed.

## Performance design

- Progressive module loading: keep the root RSL skill as the short entrypoint and load specialist modules on demand.
- Bounded concurrent Python workers and queue; bounded provider response bodies, network timeout, model turns, tool calls, command runtime/output and transcript size.
- SQLite WAL, explicit indexes and transaction boundaries for task metadata/checkpoints.
- Skip generated/dependency folders during bounded project exploration.
- No unsupported speed claims. Benchmark runtime latency, token usage, task quality/evidence completeness, cold startup and memory against a fixed task corpus before choosing cache/parallelism changes.

## Decisions deferred to measured integrations

- OS-level sandbox technology for command/tool execution and hostile binary analysis.
- Packaged private Python runtime versus approved system Python dependency.
- Provider-specific native adapters and provider capability matrix.
- Live MCP lifecycle/client and server permission contracts per protocol version.
- Live adapter validation against supported coding-agent versions.
- Benchmarked concurrency/context limits, caching policy and model routing thresholds.
