#!/usr/bin/env python3
"""Static checks for the browser-first RSL Workbench build."""
from pathlib import Path
import json
import sys

ROOT = Path(__file__).resolve().parents[1]
errors = []
checks = 0

def require(condition: bool, message: str) -> None:
    global checks
    checks += 1
    if not condition:
        errors.append(message)

package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
vite = (ROOT / "vite.config.ts").read_text(encoding="utf-8")
entry = (ROOT / "src/renderer/src/main.tsx").read_text(encoding="utf-8")
adapter = (ROOT / "src/renderer/src/browser-workbench.ts").read_text(encoding="utf-8")
html = (ROOT / "src/renderer/index.html").read_text(encoding="utf-8")
readme = (ROOT / "README.md").read_text(encoding="utf-8")

require(package["scripts"]["dev"].startswith("vite "), "dev script must launch Vite")
require(package["scripts"]["build"] == "vite build", "build script must create browser assets")
require(package["scripts"].get("preview") == "vite preview --host 0.0.0.0", "preview script must serve browser assets")
require("root: resolve(root, 'src/renderer')" in vite, "Vite must use the renderer as its web root")
require("plugins: [react()]" in vite, "React plugin is required")
require("browserWorkbench" in entry and "window.workbench = browserWorkbench" in entry, "browser adapter must be installed before React renders")
require("does not pretend to execute" in adapter, "browser adapter must clearly declare its reduced capabilities")
require("status: 'blocked'" in adapter, "browser task records must not falsely report execution")
require("localStorage" in adapter, "browser metadata storage must be explicit")
require("API keys are not saved" in readme, "browser secret-storage limitation must be documented")
require('id="root"' in html and 'type="module"' in html, "browser HTML entry point is missing")
require(not (ROOT / ".github/workflows/windows-nsis.yml").exists(), "Windows NSIS workflow must be removed")
require(not (ROOT / ".github/workflows/bootstrap-rsl-workbench.yml").exists(), "Windows bootstrap workflow must be removed")
require(not (ROOT / "scripts/build-windows.ps1").exists(), "Windows build script must be removed")
require(not (ROOT / "scripts/smoke-installed-windows.mjs").exists(), "Windows installer smoke test must be removed")
require(not (ROOT / "docs/WINDOWS_BUILD.md").exists(), "Windows build guide must be removed")

if errors:
    print("Browser structure checks failed:")
    for error in errors:
        print(f"- {error}")
    sys.exit(1)
print(f"Browser structure checks passed ({checks} checks).")
