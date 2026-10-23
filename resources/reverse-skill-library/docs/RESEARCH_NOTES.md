# Research notes

**Reviewed:** 2026-10-21. External documentation changes; URLs must be checked again at release time.

1. **OpenAI — Harness engineering (2026-02-11):** https://openai.com/index/harness-engineering/ — emphasizes repository knowledge as a system of record, concise entry maps, progressive disclosure, mechanical invariants, observability/evaluations and continuous cleanup. Applied here through a concise root skill, canonical routing/capability YAML, schema checks, and CI tests.
2. **Agent Skills / OpenCode docs:** https://opencode.ai/docs/skills/ and https://agentskills.io/specification — `SKILL.md` requires `name`/`description`; `metadata` is a string-to-string map; skill name should match directory and follow lowercase alphanumeric/hyphen rules. This exposed the old nested list-valued `metadata.requires` as nonportable.
3. **Gemini CLI Agent Skills best practices:** https://geminicli.com/docs/cli/skills-best-practices/ — supports discovery-focused descriptions, progressive disclosure, and placing detailed supporting material in references instead of bloating always-loaded instructions.
4. **OpenAI Agent Skills:** https://developers.openai.com/api/docs/guides/tools-skills — supports the separation between reusable workflow instruction and tool/runtime capability.
5. **Model Context Protocol 2026-07-28 release:** https://blog.modelcontextprotocol.io/posts/2026-07-28/ — describes the stateless protocol core, `server/discover`, multi-round-trip requests and the deprecation of Roots, Sampling and Logging. The modern protocol's lifecycle differs from the older `initialize` handshake.
6. **MCP version-era references:** https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions and https://py.sdk.modelcontextprotocol.io/v2/handlers/sampling-and-roots/ — clarify that deprecation is protocol-version dependent; deprecated features can remain functional during a transition period.
7. **OpenAI Agents SDK observability:** https://developers.openai.com/api/docs/guides/agents/integrations-observability — traces of model calls, tool calls, handoffs and guardrails enable debugging and structured evaluation.
8. **OWASP LLM application risks:** https://owasp.org/www-project-top-10-for-large-language-model-applications/ and https://owasp.github.io/www-project-top-10-for-large-language-model-applications/ — informs prompt-injection, sensitive-data disclosure, insecure output handling, excessive agency and unbounded-consumption tests.
9. **Current Agent Skills in OpenCode and Gemini CLI:** https://docs.opencode.ai/docs/skills/ and https://geminicli.com/docs/cli/skills/ — demonstrate supported discovery paths, but path/layout and behavior remain product-specific.
10. **GitHub Copilot customization documentation:** https://docs.github.com/en/copilot/concepts/customizations/comparing-customizations — shows skills, instructions, tools, MCP and hooks are distinct mechanisms, so capability categories must be detected independently.

## Research limitation

Official documentation was found for the portable skill and MCP contracts and several harnesses. Every adapter was deliberately marked as requiring runtime probing for native behavior. This audit did not install ten commercial/open-source agent products, run them, validate every documented adapter URL, or test their live hooks/subagent semantics. Accordingly, the upgraded matrix is more honest and testable, but it is not an end-to-end certification.

## Adapter-profile documentation refresh (2026-10-21)

11. **Cursor Agent Skills:** https://cursor.com/docs/skills documents project roots `.agents/skills/` and `.cursor/skills/`, user roots `~/.agents/skills/` and `~/.cursor/skills/`, and compatibility loading from Claude/Codex skill directories. Cloud-agent sync behavior differs from local discovery, so the profile lists paths as hints and still requires active-surface verification.
12. **Grok Build skills, hooks, subagents and MCP:** official docs now describe `.grok/skills/`, `~/.grok/skills/`, configurable `[skills].paths`, project/user hooks, child-session subagents, and MCP configuration. The profile has been corrected from “unknown skill support” to “documented,” while retaining `runtime_verified: false`. Grok hooks document fail-open behavior for malformed output/timeouts/crashes, so a hook alone must not be treated as a fail-closed security boundary.
13. **OpenAI product surfaces:** use current developer documentation entry points, but distinguish Codex CLI, ChatGPT/plugin skill surfaces, and Agents API concepts. SDK/API support is not proof that a local CLI exposes the same feature.
14. **Windsurf/Devin documentation transition:** https://docs.windsurf.com/ currently redirects to https://docs.devin.ai/desktop/getting-started and refers to Devin Desktop as the current product. The Windsurf adapter is therefore intentionally marked as a legacy/transition discovery hint; old paths must be verified against the actually installed product.

These documentation checks increase profile accuracy; they do not substitute for runtime probing. Documentation-backed capability values mean a product documentation page describes the feature, not that RSL has exercised it in a live product/version.
