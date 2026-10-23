# Windows x64 NSIS build

This repository now includes a Windows PowerShell packaging script and a Windows GitHub Actions workflow. **Neither creates an installer until it is actually run on a Windows build host.**

## Build locally on Windows 10/11

Prerequisites:

- Windows x64
- Node.js 22.12.0 or later (workflow pins 22.16.0)
- npm 10.9.0 or later
- Python 3.10+ on `PATH` for RSL validation/workers
- Network access to npm and Electron build asset downloads

From the extracted repository root in PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\build-windows.ps1
```

The script checks versions, installs dependencies (`npm ci` if a lockfile exists, otherwise `npm install`), runs typechecking/tests/static checks, builds Electron/Vite, invokes electron-builder for `win-x64` NSIS, verifies a `*Setup.exe` exists, and emits `SHA256SUMS.txt` and `build-manifest.json` in `release/`.

Optional:

```powershell
.\scripts\build-windows.ps1 -Clean
```

`-SkipTests` exists for debugging only; such an artifact is marked `testsSkipped: true` and should not be treated as release-verified.

## CI build

Run the **Windows NSIS installer** workflow manually from the repository's GitHub Actions page, or push a `v*` tag. It uses `windows-latest`, runs the same `npm run package:win` validation/build command and uploads the installer with its SHA-256 and build manifest as a 14-day workflow artifact. The workflow does not publish a GitHub Release.

## Lockfile and signing

The input v0.2.0 source archive does not contain a `package-lock.json`, so the first Windows build must resolve dependency metadata with `npm install`; this cannot be made reproducible merely by pinning top-level package versions. Retrieve `release/package-lock.json` from the build artifact, review it and commit it to source. Later builds will use `npm ci`.

The installer is unsigned unless the build host is configured with electron-builder code-signing credentials/certificate. An unsigned installer may trigger Windows SmartScreen. Never commit signing certificates, passwords or tokens to the source repository or workflow logs.

The application expects a usable Python 3.10+ interpreter on the destination machine. The installer currently packages the application-owned worker scripts, **not** a private Python runtime. Windows smoke testing must verify Python discovery, `safeStorage`, native SQLite loading, install/uninstall, user data retention and checkpoint recovery.

## Why this targets Windows

The project includes the native `better-sqlite3` module. Electron's native-module ABI differs from standard Node.js; the package must rebuild native modules for the target Electron runtime. A Windows build runs the native rebuild on the deployment platform and is the required verification path for this release. See the official [Electron native modules guide](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules) and [electron-builder NSIS docs](https://www.electron.build/v26/docs/nsis/).
