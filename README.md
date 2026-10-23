# RSL Workbench

Windows-first, local-first desktop Workbench for the upgraded Reverse Skill Library (RSL v3.1). Version 0.2.0 adds deterministic RSL preflight and explicit-scope Target API investigation; it remains a development build, not a production-certified release.

## What works in this slice

- Electron + React desktop shell with a sandboxed renderer, context-isolated preload and typed/allow-listed IPC.
- Project-root registration through a native folder picker; local SQLite metadata store with six versioned migrations, WAL, foreign keys, checkpoint hashes and recovery states.
- Checkpoint-backed task lifecycle and resumable **coding mode**. Side-effecting tool calls are recorded before execution; uncertain operations are not replayed blindly.
- Task-scoped, one-use, expiring approvals bound to an exact operation hash. The approval panel displays the redacted command/write preview, target, reason, expected impact and rollback details.
- Custom OpenAI-compatible chat adapter; local endpoints are restricted to loopback, cloud endpoints require HTTPS and public DNS resolution, requests are DNS-pinned, redirects are not followed, and response/time limits apply.
- OS-backed credential encryption through Electron `safeStorage`; the store fails closed when encryption is unavailable and does not return decrypted credentials to the renderer.
- Five bounded coding tools: list files, read file, literal text search, write file and run a direct-argv command. Reads redact likely secrets; writes and commands require approval; command execution has no shell and is bounded by time/output limits.
- Isolated Python worker supervisor and a small protocol for evidence-file inspection, hashing and text preview; paths are checked against registered project roots and symlink escapes are denied.
- Deterministic RSL preflight task flow: bounded capability detection, consent-gated lookup against the public `awesome-reverse-engineered` index, local query matching, candidate acknowledgement, RSL-file routing, evidence sidecars and the bundled case validator. The public index query stays local; only a fixed HTTPS index request is sent when the 24-hour cache is stale.
- Read-only Target API task flow: explicit origin/path scope, native consent dialog, DNS/IP checks, pinned HTTPS, unauthenticated GET-only requests, no redirects/crawl, bounded responses, JSON-aware secret redaction, and evidence/capture reports. This does not yet passively intercept or import traffic from other tools.
- Bundled RSL v3.1 package validator, case scaffold/validator, and skill exporter for all ten declared harness profiles.
- Provider diagnostics UI, project/task UI, activity events, evidence metadata UI, RSL validation/export UI and pending-approval UI.

## Explicitly not complete

- Full reverse-engineering specialist execution is **not yet integrated**. RSL task mode currently completes deterministic preflight, target-reuse review, routing and schema/evidence validation; it does not execute specialist modules, inspect binary contents or claim semantic results.
- Target API investigation is integrated only as an explicit, unauthenticated GET workflow. It does not passively capture browser/proxy traffic, support authenticated calls, discover endpoints automatically, fuzz endpoints, or issue mutating requests.
- Live MCP client integrations, REA/GhidraMCP execution, the ten commercial-agent runtimes/hooks and cross-agent live compatibility are not implemented/certified.
- Only OpenAI-compatible chat-completions-style provider calls are implemented. Provider diagnostics and a local custom adapter are available, but provider-specific capabilities vary; no local-to-cloud fallback occurs automatically.
- Python subprocesses are isolated from Electron’s main process, **not** secured by an OS sandbox. Commands run as the current user after exact-action approval. Do not use this build against untrusted projects/binaries as though it were a hardened malware-analysis sandbox.
- A Windows installer has not yet been built or launched. This source archive includes `scripts/build-windows.ps1` and `.github/workflows/windows-nsis.yml`; they must be run on a network-enabled Windows 10/11 host. The original environment could not reach npm, and no native `better-sqlite3` rebuild has been verified.

## Requirements

- Node.js `>=22.12.0` and npm.
- Python `>=3.10` for RSL validation and the Python worker. If Python is not on PATH, set `RSL_PYTHON_EXECUTABLE` to an absolute interpreter path.
- Windows 10/11 is the target desktop OS. Linux is useful for source-level tests but does not prove Windows lifecycle, native module or installer behavior.

## Development

```powershell
npm install
npm run dev
```

Run the validation suites:

```powershell
npm test
npm run test:syntax
npm run test:static
npm run typecheck
```

Build and create a Windows NSIS installer on Windows:

```powershell
npm run build
npm run package:win
# or from PowerShell, use the version/platform checks + checksum manifest:
.\scripts\build-windows.ps1
```

The Windows script creates `release/RSL-Workbench-0.2.0-Setup.exe` plus SHA-256/build metadata after a successful build. A first build generates a package-lock file; commit the reviewed file for reproducible subsequent installs. The script requires Python 3.10+ on the build host. See [`docs/WINDOWS_BUILD.md`](docs/WINDOWS_BUILD.md).

`npm test` includes the Electron source-contract tests, TypeScript runtime tests, SQLite schema tests and the bundled RSL validator regression suite. `npm run test:syntax` is syntax transpilation only; it is not a semantic typecheck. `npm run typecheck` and the actual Electron/Vite build require installed development dependencies.

## Safety behavior

- Renderer input is untrusted. Every privileged IPC handler checks the sender; the preload exposes named methods, not a generic IPC escape hatch.
- Prompt and trace text is redacted before persistence. Redaction is heuristic and not a guarantee that every secret will be found.
- Project-local paths are checked with canonical paths; symlink escapes are rejected.
- Reads are bounded; writes and commands require exact, expiring approvals. Approval cannot grant a blanket tool permission.
- Commands are executed with `shell: false`, but they still run with current-user privileges and are **not** OS-sandboxed.
- An interrupted operation with uncertain side effects transitions to `outcome_uncertain` and needs reconciliation before retry.
- A configured provider may receive prompts/tool context. Provider kind and destination are visible in Settings; network traffic follows that provider configuration.
- RSL mode is an evidence-producing preflight, not full reverse engineering: specialist module execution, binary analysis, MCP/REA/GhidraMCP execution and semantic result verification remain incomplete. Target API mode is an explicitly scoped read-only GET workflow, not passive traffic capture or authenticated endpoint exploration.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/SECURITY.md`](docs/SECURITY.md), [`docs/TESTING.md`](docs/TESTING.md), [`docs/FEATURE_STATUS.md`](docs/FEATURE_STATUS.md), and [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md).
