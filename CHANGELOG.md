# Changelog

## 0.2.0-dev — integrated RSL preflight and read-only Target API slice

- Added deterministic RSL preflight task orchestration: capability metadata scan, official awesome-reverse-engineered target-reuse index lookup, candidate review gate, file-format routing and bundled case validation.
- Added local-only query matching against the public CC0 index, a 24-hour verified cache, ETag/Last-Modified revalidation, response caps, URL allowlisting and provenance fields.
- Added explicit-scope, unauthenticated GET-only Target API investigation with native consent, redaction-before-persistence and evidence outputs.
- Added regression tests for index parsing/cache refresh, query privacy, target authorization, redaction and uncertain side effects.
- Updated feature status to distinguish integrated preflight from specialist reverse-engineering and passive traffic-capture work, which remain incomplete.

## 0.1.0

- Initial Windows-first Electron/React shell, typed IPC, SQLite task/checkpoint state, credential/provider diagnostics, bounded coding-agent loop and isolated Python worker protocol.
