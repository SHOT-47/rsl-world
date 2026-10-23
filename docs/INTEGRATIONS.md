# External integration contracts

## awesome-reverse-engineered index

- Source: `https://awesome.alexgaoth.com/data.json` (public index maintained at https://github.com/alexgaoth/awesome-reverse-engineered).
- The project’s README links directly to this data endpoint and reports an updated date; the app uses the fixed URL only.
- Data license reported by the project: CC0 1.0. Its scripts are MIT-licensed; Workbench implements its own matcher and does not download/execute the remote skill script.
- The task title is locally redacted and tokenized. Only a fixed GET to `data.json` may be sent; search terms are not included in the URL, headers or request body.
- Fresh cache TTL: 24 hours. Stale entries use ETag/Last-Modified validators where available. Cache SHA-256 detects corruption, but is not a signature.
- Transport: HTTPS, certificate validation, DNS/private-IP validation and pinned address, no redirect, 15-second timeout and 12 MiB response cap.
- The index is untrusted input: JSON shape and candidate URLs are validated as HTTPS URLs without embedded credentials, query strings or fragments, likely secrets are redacted, candidate code is not executed, and fit is `not_assessed` pending human review.
- Failures or zero matches never imply global uniqueness.

## Target API investigation

- Requires explicit origin/path scope, renderer acknowledgment and a separate main-process native confirmation.
- Sends only unauthenticated GET requests to the listed paths. No cookies, auth headers, custom headers, redirects, crawl, mutation verbs or fuzzing.
- Remote endpoint policy requires HTTPS and public DNS; HTTP is limited to loopback/local testing. DNS addresses are pinned per request.
- Each response is bounded and redacted before disk persistence. Evidence hashes cover persisted redacted bytes, not raw data. No credential vault material is exposed to this workflow.
- A possible network outcome stops further paths and requires reconciliation.

## Not integrated/certified

- Passive interception/import of authorized traffic from browser proxies, mitmproxy, Burp or other clients.
- Authenticated target API workflows; credential scopes, redaction and approval contract need a separate design/test phase.
- Specialist RSL execution against real binaries, native REA/GhidraMCP MCP sessions, and commercial agent runtime/hook invocation.
- Runtime certification of any of the ten adapter profiles; export success is not behavioral compatibility proof.
