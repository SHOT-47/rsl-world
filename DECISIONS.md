# Decisions (append-only)

## D-001
- decision: Build a Windows-first desktop app using Electron + React + TypeScript; keep UI in renderer and expose only narrow typed APIs through a context-isolated preload bridge.
- reason: Matches the established Workbench direction while keeping privileged operations out of UI components.
- alternatives_rejected: Native WinUI/WPF (would split the React/web-oriented direction); Tauri (would introduce a Rust host requirement before the first working slice); direct Node in renderer (violates the security boundary).
- reversible: yes, before production packaging.

## D-002
- decision: Keep orchestration in Electron main and run analysis work in managed Python child processes using JSON-line protocol with timeout, cancellation and structured outcomes.
- reason: Matches the selected hosting model and isolates worker crashes from the desktop process.
- alternatives_rejected: Run long work synchronously in main (blocks UI/lifecycle); run arbitrary Python from renderer (unsafe); require separate always-on service for the first slice (unneeded deployment complexity).
- reversible: yes.

## D-003
- decision: Use a local SQLite database for session/task/checkpoint metadata, and filesystem artifacts under a user-selected project root; store integrity hashes for persisted evidence.
- reason: Transactional local state and portable evidence files fit project-centered local-first use. Secret values will never be stored in app-managed SQLite tables or project metadata.
- alternatives_rejected: JSON files for all mutable state (weak transaction/recovery semantics); cloud storage as default (violates local-first); database blobs for all evidence (hurts portability and trace inspection).
- reversible: yes, through a schema migration layer.

## D-004
- decision: Treat the bundled RSL v3.1 library as versioned, pinned workflow content. Run its validators in a controlled local subprocess; do not silently mutate the library or claim a live harness is compatible without a real probe.
- reason: RSL is a specification library, not a reverse-engineering engine, and its own instructions require capability detection and evidence-gated outputs.
- alternatives_rejected: Reimplement RSL routing in app code (creates two sources of truth); assume adapter declarations prove support (false compatibility claim); auto-update the baseline (breaks reproducibility).
- reversible: yes, with an explicit reviewed migration.

## D-005
- decision: All tool operations pass a central risk policy. Low-risk read-only operations may run when scoped, elevated-risk actions require an exact-action approval, and prohibited actions are denied. Approval expires on material request/context changes.
- reason: Consistent authorization across native tools, Python workers and external adapters is a core requirement.
- alternatives_rejected: UI-only confirmation (bypassable); blanket allow (unsafe); prompts as enforcement (not a security boundary).
- reversible: no for the security invariant; individual risk classifications may be reviewed with tests.

## D-006
- decision: Use better-sqlite3 with WAL, foreign keys, a 5-second busy timeout, FULL synchronous durability, and versioned SQL schema files. Persist redacted prompt/checkpoint/event text; write checkpoint metadata, task status and trace event within a database transaction.
- reason: Short local metadata transactions are fast and reliable with SQLite; keeping evidence as project artifacts avoids bloating the metadata database. WAL improves concurrent readers, while FULL synchronous supports checkpoint durability.
- alternatives_rejected: JSON-only mutable state (weaker transaction semantics); experimental runtime SQLite API (higher stability uncertainty); database BLOBs for all evidence (poor portability); persist raw prompts/secrets (violates sensitive-data boundary).
- reversible: yes, through a schema migration and data export/import path.


## D-007
- decision: Implement RSL target reuse as a locally matched query over the official public awesome-reverse-engineered index; send only a fixed HTTPS dataset request, never a target-specific search query, and require user review before triage if candidates are found.
- reason: Satisfies RSL's target-reuse-first requirement while minimizing disclosure of potentially sensitive target names. Cache validation, freshness metadata and explicit failure states make the behavior auditable.
- alternatives_rejected: Generic GitHub repository search (not the required index); uploading project-derived queries to a search provider; silently treating a failed lookup as no prior art.
- reversible: yes, through an explicit reviewed integration change.

## D-008
- decision: Initial Target API mode is limited to explicitly scoped, unauthenticated GET requests with native consent, destination/IP validation, no redirect/crawl, size caps, redaction-before-persistence and evidence sidecars.
- reason: Enables a testable API investigation slice without inventing authenticated-secret handling or allowing arbitrary network actions prematurely.
- alternatives_rejected: Automatic crawling/fuzzing, forwarding provider credentials, mutating verbs, or importing untrusted browser traffic without a separate threat model and permissions design.
- reversible: yes, after separate authorization, credential, passive-capture and red-team design reviews.
