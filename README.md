# RSL Workbench

Browser-first workbench UI for the Reverse Skill Library (RSL v3.1). The current browser build is a **preview shell**: it runs in a standard browser and stores non-secret task/provider metadata in that browser's local storage. It does not yet have a deployed secure execution backend.

## Run in a browser

Requirements: Node.js 22.12+ and npm.

```sh
npm install
npm run dev
```

Open the URL printed by Vite (normally http://localhost:5173). To build static browser assets:

```sh
npm run build
npm run preview
```

The generated site is written to `dist/` and can be hosted on a static web host.

## Browser preview limitations

A browser cannot safely replace the former privileged desktop runtime on its own. The browser preview therefore does **not** execute shell commands, launch Python workers, access arbitrary project paths, use SQLite or OS credential encryption, or run coding-agent tasks. Task records are saved as blocked rather than falsely reported as executed. API keys are not saved by this preview. Those capabilities require a separately deployed, authenticated backend with server-side secret storage, project/file sandboxing, approval enforcement, and audit logging.

The RSL library, schemas, documentation and server-side runtime source remain in the repository for a future backend integration. Windows installer workflows, NSIS packaging scripts, the Windows build guide, and the Windows build-kit archive have been removed from this migration branch.

## Validation

```sh
npm run build
npm run typecheck
npm test
npm run validate:rsl
```

The full test suite still includes the original local-runtime contract tests; browser preview support does not imply that those backend capabilities are exposed to a browser.

## Architecture proposal

The proposed **Cleanup Loop** and **Token Assist** design is documented in [Context Intelligence](docs/CONTEXT_INTELLIGENCE.md). It is a backend architecture proposal, not a feature currently enabled in the browser preview.
