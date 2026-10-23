# Security model and current limitations

## Assets and boundaries

Assets include project files, model/provider credentials, target API credentials, prompt/trace data, approval decisions, and evidence provenance. The trust boundary runs between the web renderer, Electron main process, model provider, project workspace, Python worker, child commands, MCP servers, and future external coding-agent processes.

## Controls in this slice

- Electron context isolation, no Node integration in the renderer, sandbox enabled, Content Security Policy, navigation/new-window denial, and sender validation for IPC.
- Explicit IPC methods and structured shared contracts; no arbitrary renderer-supplied command channel.
- Credentials stored through `safeStorage` encryption injection; no plaintext fallback when encryption is unavailable; decrypted credentials are not returned to renderer summaries.
- Provider URL checks: loopback-only local models; HTTPS and public DNS for cloud models; DNS-pinned request, TLS verification, no redirects, bounded responses and timeout.
- Canonical filesystem path checks, secret-like filename blocks, bounded read/write sizes, atomic writes, symlink escape checks and redaction before persistence/model context.
- Exact-action, single-use, expiring approvals for writes/commands; operation hash binds relevant parameters and the approval preview shows redacted proposed content.
- Python subprocess isolation with sanitized environment, JSON-line protocol, bounded queue/concurrency, timeout, cancellation and output limits.
- Hash-checked checkpoint and evidence metadata; uncertain side-effect recovery blocks automatic replay.

## High-risk limitation

**The command tool is not a sandbox.** It uses direct argv (`shell: false`) and blocks shell interpreters/common script wrappers, but an approved executable can still have broad current-user rights. A process may read/write outside the project or access networks unless the executable itself and OS configuration prevent it. Before production or untrusted-code use, add and test OS-level isolation, executable policy, network egress controls, per-process resource limits and stronger command argument/path inspection. Do not treat user approval alone as a security boundary.

Likewise, secret redaction is heuristic; use data minimization and scoped credential references. The prior-art index cache contains public metadata; its SHA-256 digest detects accidental corruption, not a malicious same-user rewrite of both payload and digest. Child process output, diagnostics and API captures must be treated as untrusted. RSL preflight and the bounded read-only Target API workflow now have runtime-enforced consent and evidence gates. Specialist reverse-engineering execution, authenticated API traffic, passive observed-traffic capture and live MCP/external-agent adapters remain disabled until their own authorization, isolation and evidence contracts pass integration tests.

## Threats that still need red-team testing

- Prompt injection in repository files and tool responses.
- Symlink/junction races and Windows reparse points between validation and write.
- Windows command-line behavior, executable resolution, PATH hijack and malicious package scripts.
- DNS rebinding, IPv6 special-use addresses, proxies and provider endpoint edge cases.
- Key-redaction recall against real credential formats and structured data.
- Process tree cancellation and job-object/resource isolation.
- Database corruption/crash at every side-effect/checkpoint boundary.
- IPC spoofing, renderer navigation, update/signing/installer tamper and downgrade.
