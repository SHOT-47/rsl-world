# Cross-agent compatibility matrix

**Basis reviewed:** 2026-10-21. The rows below describe package strategy and validation coverage, not a claim that every product/version was run in end-to-end tests.

| Harness profile | Portable skill discovery status in profile | Native features (hooks, MCP, subagents, streaming, checkpointing, approvals) | Required proof before claiming compatibility |
|---|---|---|---|
| Claude Code | Documented; validate active config/path | Probe individually; event names/config evolve | Load skill; inspect settings; fixture hook, MCP call, denial and delegated task |
| Cursor | Agent Skills format and project/user roots documented; probe active version, path and remote sync | Probe individually; docs differ by local/cloud surface | Load skill in selected Cursor version; run capability fixtures and verify local-vs-cloud path scope |
| Codex | Shared portable skill paths are hints; current OpenAI docs span distinct surfaces | Probe active Codex surface; do not infer CLI features from ChatGPT plugins or Agents API | Load skill in selected Codex version; verify model/tool interaction, hooks and approval semantics |
| Gemini CLI | Documented Agent Skills surface; validate active context | Probe hooks, agents, MCP lifecycle and policies | Load skill; exercise hooks/subagents/MCP/cancel with fixtures |
| GitHub Copilot | Agent Skills/customization documented; selected product surface matters | Feature availability varies by CLI/IDE/cloud; probe | Verify in selected Copilot environment, not only GitHub documentation |
| OpenCode | Documented Agent Skills path aliases; validate config/permissions | Probe version/plugins and each capability | Load skill and exercise permission/tool/delegation fixtures |
| Cline | No unsupported native capability claim; probe skills/workflows | Probe individually | Verify the exact installed Cline version; use manual fallback if necessary |
| Windsurf / Devin transition | Legacy hints only; docs.windsurf.com currently redirects to Devin Desktop docs | Identify actual installed product/version; probe all native features | Verify product identity, current skill mechanism and installed features; do not infer from legacy settings |
| Grok Build | Official docs document Agent Skills paths; runtime load still untested | Skills, hooks, subagents and MCP documented; isolation, fail-closed enforcement, budgets and cancellation must be probed | Verify actual version, skill ingestion, hook failure behavior, tool scope, child-session isolation and MCP calls |
| Generic | Manual `SKILL.md` loading; no native features assumed | Unsupported until configured | Verify user-provided mechanism and record every manual capability |

## Compatibility levels

- **Portable core:** valid Agent Skills frontmatter and standard folder packaging.
- **Profile-guided:** adapter provides candidate paths and official documentation entry points.
- **Runtime-observed:** a feature was exercised against the active product/version and evidence recorded.
- **End-to-end-validated:** the acceptance scenarios pass in that product/version. Only this level justifies an E2E compatibility claim.

Never turn a static configuration declaration into an observed result. Missing event hooks should result in explicit manual gates, not silent omission. Unsupported capabilities should degrade safely or block the specific operation.
