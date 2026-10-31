# Context Intelligence: Cleanup Loop and Token Assist

**Status:** Architecture and backend primitives implemented; native agent lifecycle integration active; reduced-context compaction disabled; browser preview has no execution backend  
**Scope:** RSL Workbench agent runtime and future authenticated execution backend  
**Decision:** Adopt both capabilities after the corrections and safety gates in this document.

## 1. Executive decision

Keep the user-facing names **Cleanup Loop** and **Token Assist**, but implement them as two cooperating, independently testable services:

- **Cleanup Loop — Context Lifecycle Manager:** maintains a task-scoped, evidence-preserving working context. It detects stale, duplicated, superseded and irrelevant material; prepares compaction; verifies preservation; and only then replaces the active context.
- **Token Assist — Context Allocation Planner:** assembles the next model input from task requirements, protected state, recent interaction and retrieved evidence. It allocates a model-specific token budget, estimates request cost, and calibrates estimates against actual provider usage.

A third service is required for both:

- **Context Health Auditor:** checks preservation, provenance, consistency, relevance, tool-call integrity and budget safety. It is a gate on compaction and request construction, not a decorative percentage.

The combined loop is:

`Observe → Plan → Assemble → Audit → Call model → Reconcile usage → Update task state`

At safe lifecycle boundaries:

`Snapshot → Propose cleanup → Verify preservation → Commit or rollback → Audit`

This is event-driven, not an always-running process that repeatedly spends tokens on its own optimization.

## 2. The key design corrections

### 2.1 Do not equate cleanup with deletion

Removing an item from the active prompt must never imply deleting the underlying record. The system maintains:

1. **Immutable task event/evidence history:** original user messages, tool requests and results, decisions, findings, evidence references, timestamps and integrity hashes.
2. **Structured task memory:** the current requirements, constraints, decisions, verified facts, rejected hypotheses, unresolved questions, side-effect state and evidence references.
3. **Active model context:** the deliberately selected subset sent on the next inference request.
4. **Compaction snapshots:** versioned, reversible records of how the active context was derived.

The active context may become smaller. The task's source history must remain recoverable under the configured retention policy.

### 2.2 A large context window is capacity, not a quality target

Never hardcode a 1M-token context window. Read the selected provider/model capability when known, apply the application's configured cap, and treat unknown limits conservatively. If a model supports a 1M window, the planner may use that capacity when the task benefits from it; it must not fill it merely because it exists.

Long-context models can still be position-sensitive and miss information buried in the middle. Relevant information should be selected and deliberately placed, not merely retained.

### 2.3 Token Assist is not an internal model-token predictor

A normal provider API does not expose arbitrary internal activations, attention maps, or future-token logits. Token Assist must not claim that it predicts or controls the model's internal next-token decisions.

Its job is to predict **context needs and token cost**: which information should be retrieved, how much budget each category gets, and how to structure the request. A provider-specific tokenizer may count tokens exactly; otherwise the estimate must be labelled and calibrated, never presented as exact.

### 2.4 No uncontrolled self-improvement or infinite retries

The live task loop must not silently rewrite model weights, change safety policy, or rerun completed work simply because a health score moved. Optimization strategies are evaluated offline against a versioned benchmark corpus. Promotion requires measured quality gains with no critical regression. A task retry requires an explicit retry policy and a known, safe state.

## 3. Architecture and ownership

### 3.1 Context Ledger

Append-only task-scoped records with stable IDs and integrity hashes. Each record should carry:

- Task ID and record ID.
- Kind: user requirement, model message, tool call, tool result, decision, finding, evidence, rejected hypothesis, unresolved question, or status.
- Source reference(s), time, and content hash.
- Trust/provenance class and sensitivity classification.
- Whether the item is protected, active, archived, superseded or eligible for retrieval.
- For tool calls, the call ID and matching result state.

Raw tool output may be stored as a bounded evidence artifact rather than copied into every prompt. Store the artifact path/reference, content hash, relevant line/range or structured pointer, and a short safe preview. The agent must be able to retrieve the full approved artifact when needed.

### 3.2 Structured Task Memory

Keep a compact, task-specific state separate from prose summaries. At minimum:

- Original task objective and acceptance criteria.
- Exact user constraints, prohibitions and decisions.
- Current stage and next action.
- Verified findings with evidence references.
- Rejected hypotheses and why they were rejected.
- Open questions and unresolved conflicts.
- Changed files/actions and verification results.
- Pending or uncertain side effects and approval state.
- Model/provider identity and relevant capability profile.

A generated summary is a *derived view*, never the authoritative source of a requirement or evidence item. Every factual memory entry must cite one or more source record IDs. Conflicting facts remain visibly conflicted until reconciled; a summarizer must not silently choose one.

### 3.3 Cleanup Loop — Context Lifecycle Manager

Responsibilities:

- Detect duplicate/repeated content, completed subtask noise, stale observations and oversized tool payloads.
- Identify safe compaction boundaries.
- Propose an active-context replacement.
- Preserve protected state and unresolved tool-call pairs.
- Validate the candidate context before atomic activation.
- Retain the previous snapshot for rollback and audit.

It must not independently decide to delete files, evidence, approvals, secrets, task history or user requirements. Context cleanup is not filesystem cleanup.

### 3.4 Token Assist — Context Allocation Planner

Responsibilities:

- Resolve model-specific context and output limits.
- Determine a conservative input budget.
- Select task-relevant memory/evidence.
- Rank and deduplicate candidate context items.
- Keep stable policy/tool prefixes stable where practical.
- Construct the request and record estimated versus actual token usage.
- Adapt future allocations from measured outcomes.

The planner is provider-neutral at its interface, with provider-specific capability/tokenizer adapters behind it.

### 3.5 Context Health Auditor

Audit before a context is committed and before a model request is sent. Report independent dimensions rather than relying on one opaque score:

- **Protected-state coverage:** every mandatory requirement, prohibition, policy and unresolved side-effect state remains available.
- **Provenance coverage:** every retained factual claim has a source or is explicitly marked as an inference/unknown.
- **Tool integrity:** no dangling assistant tool call; every call/result pair is preserved; no uncertain side effect is represented as complete.
- **Consistency:** conflicting or superseded facts are labelled, not silently merged.
- **Relevance:** active material is connected to the task's current objective or a required invariant.
- **Budget safety:** the request estimate, uncertainty margin, output reserve and tool/schema overhead fit the model profile.

A weighted health score may help visualize trends, but it must never allow a high relevance score to compensate for a missing user prohibition or an unresolved side effect. Critical checks are hard gates.

## 4. Context composition and protection rules

Construct requests in a predictable order:

1. Immutable system/developer policy and tool definitions.
2. Exact user objective, requirements, acceptance criteria and prohibitions.
3. Structured task state and current plan.
4. Verified findings, decisions and relevant evidence references.
5. Necessary retrieved project/evidence excerpts.
6. Recent conversation turns and current user message.

Keep stable instructions and tool definitions in a stable prefix where the provider supports prompt caching. Put dynamic task-specific information later. Do not rewrite the entire history on every turn without reason: compaction can reduce cache reuse because it changes the shared prefix.

### Preservation classes

| Class | Examples | Rule |
|---|---|---|
| P0 — Immutable policy | system rules, risk limits, workspace boundaries | Never compact away or weaken |
| P1 — User authority | objective, exact constraints, prohibitions, approvals | Preserve exact meaning; keep original source |
| P2 — Execution safety | tool-call/result pairs, in-flight state, uncertain side effects | Never drop or rewrite while unresolved |
| P3 — Verified task state | test results, evidence-backed findings, decisions | Preserve as structured facts with source refs |
| P4 — Working context | current plan, active file excerpts, recent discussion | Compress/retrieve with provenance |
| P5 — Reconstructible noise | duplicate explanations, superseded drafts, irrelevant output | Remove from active context; archive according to retention |

Untrusted repository content, tool output, downloaded text and model-generated summaries remain data, never instructions. They cannot elevate their trust class or alter system policy.

## 5. Token Assist algorithm

### 5.1 Model capability profile

Resolve and record, per provider/model/version where available:

- Context-window limit.
- Maximum output-token limit.
- Tokenizer identity and version.
- Exact local token-count support, provider preflight count support, or estimate-only status.
- Native compaction support and semantics.
- Tool-definition and multimodal accounting requirements.
- Whether usage counters are returned and which fields are reliable.

Never infer a 1M window from a provider name or a neighbouring model. If capability is unknown, use a conservative configurable cap and reject requests that cannot be budgeted safely.

### 5.2 Budget calculation

Let:

- `W` = verified model context capacity.
- `C` = application-configured maximum context cap.
- `O` = reserved output tokens.
- `R` = reasoning-token reserve when applicable.
- `T` = tool definitions / protocol overhead reserve.
- `M` = multimodal or provider-specific overhead reserve.
- `U` = estimation-uncertainty margin.

Then:

`EffectiveInputBudget = min(W, C) - O - R - T - M - U`

All reserves must be bounded, visible in telemetry and included in preflight. The planner must fail closed when the effective budget is zero/negative or a safe estimate cannot be obtained.

Initial trigger thresholds (to be tuned by measured model/provider behavior, not treated as universal truths):

- Below 70% of effective input budget: normal planning.
- At/above 70%: warn and avoid adding low-value context.
- At/above 80%: schedule compaction/retrieval before the next model request if a safe boundary exists.
- At/above 90%: do not send an over-budget request; compact, retrieve less, reduce nonessential payloads, or stop with an explicit budget blocker.

These ratios apply to the **effective input budget**, not blindly to the model's advertised context window.

### 5.3 Token counting hierarchy

Use the strongest available method:

1. Exact tokenizer matching the selected model/version.
2. Provider's documented token-count/preflight endpoint.
3. Calibrated conservative estimator, marked approximate.
4. If no defensible estimate exists, apply a conservative payload cap and block unsafe requests.

After every model response, reconcile the estimate against provider-reported prompt usage. Do not confuse completion tokens with prompt tokens. Update calibration by provider, model, request shape and modality; do not transfer calibration blindly between models.

### 5.4 Context item ranking

Rank candidate items using multiple explainable signals:

- Task objective and current phase relevance.
- Trust/provenance and evidence quality.
- Whether it is a protected or unresolved item.
- Freshness and whether it has been superseded.
- Unique information versus duplication.
- Expected cost in tokens.
- Explicit dependency from the current plan.

Hard-protected information bypasses ranking and is always included. Relevance ranking must not use recency alone. The planner records why each selected item is present and why each omitted item was excluded, with a source reference for later retrieval.

### 5.5 Adaptation

After each request, record:

- Estimated input tokens and estimate method.
- Actual prompt/completion/total tokens when returned.
- Model/profile and prompt-assembly version.
- Compaction/retrieval actions.
- Latency and provider errors.
- Task outcome and verification evidence.

Use the difference between estimated and actual prompt usage to calibrate the next request. Use task-quality evaluations to adjust selection/ranking weights offline. Token savings alone are not proof of improved performance.

## 6. Cleanup Loop lifecycle

### 6.1 Event-driven triggers

Evaluate context health:

- Before each model request.
- After a completed tool result has been durably checkpointed, when the next request needs planning.
- At safe phase boundaries.
- When the context approaches its effective budget threshold.
- After restart/resume and before any new model call.
- When a provider/model changes.
- On task completion, cancellation or failure, for final audit and archival.

Do not run a background cleanup timer that continuously rewrites the context without a lifecycle event.

### 6.2 Safe-boundary requirements

Do not compact while:

- A side-effecting operation is in flight or its result is uncertain.
- An assistant tool call is missing its matching tool result.
- An approval is pending or being consumed.
- A checkpoint write is incomplete.
- The current transcript cannot be reconciled with durable task state.

At these points, finish the exact operation/result checkpoint or stop and report the blocker. Never compact away the information needed to reconcile a possibly executed action.

### 6.3 Two-phase compaction transaction

1. **Snapshot:** capture the active transcript/state, source IDs, versions and hashes.
2. **Classify:** label protected, verified, unresolved, stale, duplicate and reconstructible items.
3. **Propose:** build a smaller context and structured memory update. A model-generated summary is optional and must be treated as untrusted derived content.
4. **Verify:** assert all P0–P3 requirements and tool integrity; verify every factual memory entry has source references; detect contradictions; check the budget; run critical-fact retrieval checks.
5. **Commit:** atomically create a new versioned context snapshot and make it active.
6. **Rollback:** on any failed invariant, retain the old active context and report the failed check.
7. **Measure:** compare size, coverage, request cost and subsequent task-quality metrics.

The raw source record remains available under retention policy. Compaction is reversible as a context operation, not destructive deletion.

### 6.4 Task completion health check

On completion, audit:

- Whether the original acceptance criteria are still represented.
- Whether conclusions are backed by recorded evidence.
- Whether tool/side-effect outcomes are reconciled.
- Whether any contradiction or unresolved question remains.
- Whether the final answer is consistent with the task record.
- Whether the compacted memory can be restored and retrieved.

A failed audit changes the task to an honest degraded/blocked/failed verification state. It must not silently convert a task into success or automatically rerun side effects. Cleanup after completion is archival/health maintenance; it does not keep the completed agent executing forever.

## 7. Safety, privacy and reliability invariants

1. **Task isolation:** no cross-task memory is inserted unless explicitly shared through an approved, provenance-carrying artifact.
2. **No authority escalation:** summaries and retrieved files never become system/developer instructions.
3. **No loss of user intent:** exact user constraints and prohibitions remain recoverable and active.
4. **No uncertain replay:** compaction never changes side-effect state or authorizes a retry.
5. **No approval mutation:** approval grants remain bound to the exact operation hash and expiry; summaries cannot broaden them.
6. **Secret minimization:** redact before persistence/model context where possible; never persist credentials in summaries, metrics or debug traces.
7. **Bounded work:** compaction calls, retries, retrieval depth, tokens, time and cost have explicit limits and cancellation.
8. **Fail-safe fallback:** if summarization, token counting or health validation fails, preserve the previous context, reduce nonessential retrieval or stop; do not erase context to fit.
9. **Auditability:** every context mutation has before/after snapshot IDs, hashes, source references, reason and result.
10. **No unmeasured performance claims:** publish accuracy, latency and cost results only from repeatable evaluations.

## 8. Evaluation and acceptance criteria

Build a versioned benchmark set with long coding tasks, multi-step RSL investigations, large tool outputs, contradictory evidence, explicit user prohibitions, task resumes and malicious prompt-injection content. Include cases where the critical fact appears early, in the middle and late in the transcript.

Compare baseline (no cleanup/planning) with each feature independently and together.

Measure at minimum:

- Acceptance-criteria completion and independent verification pass rate.
- Retention/recall of protected requirements and prohibitions.
- Evidence provenance and factual attribution.
- Correct handling of unresolved tool calls and uncertain side effects.
- Tool selection/call validity and recovery behavior.
- Prompt and completion tokens, cache reuse where available, latency (median/p95), provider cost and memory.
- Summary drift, contradiction rate, retrieval misses and rollback rate.
- User corrections and regressions across a fixed task corpus.

### Release gates

- Zero loss of P0/P1 protected requirements in the adversarial compaction suite.
- Zero dangling tool calls or compaction across unresolved side effects/approvals.
- Every summarized factual claim is traceable to source record(s).
- Restart restores the last verified context snapshot and source links.
- Unknown/smaller model limits never result in an over-budget request.
- Failed compaction leaves the previous active context unchanged.
- Task isolation and prompt-injection tests pass.
- No statistically meaningful drop in task correctness/evidence completeness against baseline; any token/latency savings are reported separately from quality.
- A real provider/model evaluation has been run before enabling automatic compaction by default.

## 9. User-facing controls and observability

The Workbench should show:

- Model context capacity and where that number came from.
- Effective input budget, estimated usage and actual usage.
- Estimate confidence/source (exact tokenizer, provider count or approximate).
- Protected/active/retrievable/archived context categories.
- Context-health dimensions and any hard-gate blocker.
- Compaction preview: what changes, what remains protected and why.
- Before/after token estimates and expected cache impact.
- Snapshot history, rollback and source evidence navigation.
- Why Token Assist selected or omitted a context item.

The user should be able to inspect the context plan. Provide a policy to disable automatic compaction, set task/provider limits and require approval for high-impact retention changes. Do not hide a cleanup action that materially changes what the model can see.

## 10. Implementation sequence

### Phase 0 — Specification and baseline

- Freeze these invariants and context data contracts.
- Record a deterministic baseline task corpus.
- Add provider capability metadata and usage telemetry requirements.
- No runtime behavior change.

### Phase 1 — Token Assist in shadow mode

- Add model-specific context profiles and token-estimation adapters.
- Add preflight budgeting and estimated-versus-actual telemetry.
- Assemble and explain context plans without changing the prompt sent to the model.
- Compare estimates and rankings against baseline behavior.

### Phase 2 — Deterministic Cleanup Loop

- Add task-scoped context ledger and structured memory.
- Add safe-boundary detection, snapshot/version/hash support and reversible deterministic compaction.
- Preserve raw history/evidence and enforce hard gates.
- Start with user-visible previews or opt-in automatic compaction.

### Phase 3 — Assisted summaries and retrieval

- Add bounded model-assisted summaries as untrusted derived artifacts with source IDs.
- Validate claims, coverage and critical-fact retrieval before activation.
- Add targeted retrieval of archived tool outputs and project evidence.
- Roll back on validation failure.

### Phase 4 — Evaluation-led adaptation

- Run offline strategy comparisons and regression tests.
- Tune model-specific thresholds and ranking weights only from measured results.
- Enable automatic behavior per provider/model after release gates pass.
- Retain user override, disable switch and audit trail.

## 11. Current repository baseline and integration constraint

The inspected `web-browser-migration` branch contains the original agent-runtime source for future backend integration, but its README explicitly describes the browser app as a preview shell without a deployed secure execution backend. Therefore this document does **not** claim that the browser preview currently runs Cleanup Loop or Token Assist.

### Initial implementation added on `feat/context-intelligence-phase1`

- `src/main/agent/context-intelligence.ts` provides model-budget arithmetic, low-confidence shadow estimation, provider-usage reconciliation, context selection, provenance/tool-pair audits, deterministic P4/P5 duplicate cleanup proposals and health summaries.
- `src/main/agent/runtime.ts` records Token Assist preflight estimates and provider-reported prompt-usage observations. It leaves the model request unchanged and explicitly reports that the model context profile is unknown.
- `resources/schema/007_context_intelligence.sql` adds an append-only task context ledger and immutable-content versioned snapshots with a single-active-snapshot constraint.
- `TaskStore` adds redacted, hash-checked context record append/read operations, safe-boundary-gated snapshot proposal, compare-and-swap activation and integrity-checked active snapshot reads.
- `tests/context-intelligence.test.ts` and expanded `tests/test_schema.py` cover the deterministic planner, preservation/provenance/tool-pair gates, cleanup rollback behavior and database constraints.

### Agent lifecycle integration on `web-browser-migration`

The current runtime integration now performs the following at every safe pre-inference boundary and before final task success:

1. Redacts and durably checkpoints the current conversation.
2. Appends new conversation messages to the task-scoped context ledger using stable transcript source references.
3. Audits user messages, ledger provenance and complete assistant-tool-call/tool-result pairs.
4. Runs the Cleanup Loop assessment. With no verified model/tokenizer budget it records a blocker and preserves every active record.
5. Creates and activates a versioned snapshot with compare-and-swap protection.
6. Reconstructs the model request transcript exclusively from the active snapshot, while re-inserting the immutable runtime system prompt.

Snapshot synchronization is incremental and resume-safe: records represented by the prior snapshot remain in their prior active/archived state; only ledger records added after that snapshot are admitted into the next active view. This also recovers ledger entries written just before a crash interrupted snapshot activation. Missing or overlapping snapshot references fail closed. Mandatory P0–P2 and explicitly required records cannot be archived even when a stale snapshot incorrectly marks them inactive.

Resume no longer silently trims the checkpoint transcript to the last 80 messages. If the reconstructed conversation exceeds the provider adapter's current 80-message request limit, the task stops with an explicit context-preservation blocker rather than discarding older user instructions. The current chat adapter also enforces a 500 KB request payload cap; neither limit is yet resolved by automatic compaction.

This is the live lifecycle integration slice, not the full feature. Token estimates remain deliberately low-confidence until a verified provider/model tokenizer profile is integrated. The runtime activates a full-context snapshot and reconstructs model requests from it, but it does not activate a reduced/compacted proposal while the model token budget remains unverified. No model-assisted summarization, semantic retrieval, user-facing context dashboard or browser-preview execution is claimed.

The latest native runtime integration test exercises an actual AgentRuntime call against a loopback OpenAI-compatible mock and a real SQLite TaskStore. It verifies the user request is sent, the model request is reconstructed from active snapshot records, a previously archived record is not reintroduced, and the assistant's final answer is persisted before the task is marked succeeded. This is a successful-flow integration test, not a forced process-crash/restart test.

Remaining constraints:

- src/main/agent/runtime.ts bounds the transcript checkpoint at MAX_TRANSCRIPT_BYTES = 900_000 bytes and stops the task if the checkpoint exceeds that limit.
- Tool outputs are character-limited before being returned to the model. This is a payload guard, not model-token accounting or a semantic relevance decision.
- src/main/providers/chat-completions.ts exposes provider-reported prompt/completion/total token usage after inference, but provider configuration still has no verified model context-window/tokenizer capability profile or exact preflight token-count adapter.
- Automatic reduced-context activation, model-assisted summaries, semantic retrieval, and crash/restart fault-injection coverage remain outstanding.

The browser preview must remain a safe UI shell. Actual model execution, context persistence, compaction, secret handling and task isolation belong in a separately deployed authenticated backend with the existing workspace, policy, approval, checkpoint and audit controls. Do not expose privileged context or execution operations directly to browser code.

## 12. Sources and rationale

- Liu et al., *Lost in the Middle: How Language Models Use Long Contexts*, TACL 2024: long-context retrieval can be position-sensitive. https://aclanthology.org/2024.tacl-1.9/
- OpenAI API documentation, *Compaction*: server-side compaction is a mechanism for carrying forward needed state with fewer tokens; compaction should be treated as explicit conversation-state management. https://developers.openai.com/api/docs/guides/compaction
- OpenAI API documentation, *Prompt caching*: stable prefixes and preserving conversation history can improve cache reuse; changing/compacting earlier content can change cache reuse. https://developers.openai.com/api/docs/guides/prompt-caching

These sources support design constraints, not a claim that one implementation is optimal for every provider. RSL Workbench must validate behavior against its own supported provider/model matrix and task corpus.
