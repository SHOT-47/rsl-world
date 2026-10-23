#!/usr/bin/env python3
"""Fast static architecture guardrails; complements executable and E2E tests."""
from pathlib import Path
import json
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
errors: list[str] = []
checks = 0

def require(condition: bool, message: str) -> None:
    global checks
    checks += 1
    if not condition:
        errors.append(message)

package = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
main = (ROOT / 'src/main/index.ts').read_text(encoding='utf-8')
preload = (ROOT / 'src/preload/index.ts').read_text(encoding='utf-8')
contracts = (ROOT / 'src/shared/contracts.ts').read_text(encoding='utf-8')
renderer = (ROOT / 'src/renderer/src/App.tsx').read_text(encoding='utf-8')
task_store = (ROOT / 'src/main/task-store.ts').read_text(encoding='utf-8')
task_state = (ROOT / 'src/main/task-state.ts').read_text(encoding='utf-8')
policy = (ROOT / 'src/main/policy.ts').read_text(encoding='utf-8')
agent_runtime = (ROOT / 'src/main/agent/runtime.ts').read_text(encoding='utf-8')
tool_broker = (ROOT / 'src/main/agent/tool-broker.ts').read_text(encoding='utf-8')
chat_adapter = (ROOT / 'src/main/providers/chat-completions.ts').read_text(encoding='utf-8')
provider_http = (ROOT / 'src/main/providers/openai-compatible.ts').read_text(encoding='utf-8')
provider_store = (ROOT / 'src/main/providers/provider-store.ts').read_text(encoding='utf-8')
worker_runner = (ROOT / 'src/main/runtime/python-worker.ts').read_text(encoding='utf-8')
rsl_service = (ROOT / 'src/main/rsl-integration.ts').read_text(encoding='utf-8')
rsl_workflow = (ROOT / 'src/main/workflows/rsl-investigation.ts').read_text(encoding='utf-8')
target_api_workflow = (ROOT / 'src/main/workflows/target-api-workflow.ts').read_text(encoding='utf-8')
schema = '\n'.join(p.read_text(encoding='utf-8') for p in sorted((ROOT / 'resources/schema').glob('*.sql')))

require(package['main'] == 'out/main/index.js', 'package main must match electron-vite output')
require('electron-vite dev' in package['scripts']['dev'], 'development script missing')
require('electron-vite build' in package['scripts']['build'], 'production build script missing')
require(('python -m unittest discover -s resources/reverse-skill-library/validation' in package['scripts']['test']) or ('python resources/reverse-skill-library/validation/test_library.py' in package['scripts']['test']), 'top-level test command must include RSL validator regression tests')
require(('python -m unittest discover -s tests -p' in package['scripts']['test']) or ('python tests/test_schema.py' in package['scripts']['test']), 'top-level test command must include SQLite schema tests')
require('contextIsolation: true' in main, 'context isolation must remain enabled')
require('nodeIntegration: false' in main, 'Node integration must remain disabled')
require('sandbox: true' in main, 'renderer sandbox must remain enabled')
require('setWindowOpenHandler' in main and 'will-navigate' in main, 'navigation controls missing')
require('assertTrustedSender' in main and 'isAllowedUrl' in main, 'sender validation missing')
require('contextBridge.exposeInMainWorld(\'workbench\', api)' in preload, 'typed preload surface missing')
require('ipcRenderer' not in renderer, 'renderer must not import Electron APIs')
require(not re.search(r'(?:exec|spawn|execFile)\s*\(', preload), 'raw process execution found in preload')
require('executeCommand' not in contracts and 'runShell' not in contracts, 'raw command IPC must not exist')
require('spawn(executable, commandArgs' in tool_broker and 'shell: false' in tool_broker, 'commands must use direct argv without a shell')
require('requestApproval' in tool_broker and 'onBeforeSideEffect' in tool_broker and 'onAfterSideEffect' in tool_broker, 'side-effect tools must have approval and durable checkpoint hooks')
require('MAX_TURNS' in agent_runtime and 'MAX_TOOL_CALLS' in agent_runtime and 'MAX_WALL_MS' in agent_runtime, 'agent loop must have bounded turns, tools and wall time')
require('findUnansweredToolCalls' in agent_runtime, 'resume must reconcile persisted tool calls rather than regenerate blindly')
require('Task stopped for reconciliation' in agent_runtime and "if (state.sideEffectState === 'possible')" in agent_runtime, 'uncertain side effects must stop the loop before a duplicate model tool call')
require('cancelAndWait' in agent_runtime and 'await agentRuntime.cancelAndWait' in main, 'shutdown must wait for task cancellation/checkpoint completion')
require('this.database.transaction' in task_store and 'writeCheckpoint' in task_store, 'checkpoint writes must use database transactions')
require('assessRecovery' in task_store and 'evaluateApproval' in task_store, 'recovery and approval state machines must be used by persistence')
require('sanitizeJson' in task_store and 'safePrompt.value' in task_store, 'checkpoint/prompt redaction must run before persistence')
require('action_details_redacted' in task_store, 'approval persistence must include a redacted exact-action preview')
require('REFERENCES projects(root)' in schema and 'CHECK (status IN' in schema, 'database integrity constraints missing')
require('isWithinWorkspace' in policy and 'HARD_DENY' in policy, 'central policy checks missing')
require('safeStorage' in provider_store or 'encryptString' in provider_store, 'credential store must use OS-backed encryption abstraction')
require('encryptString' in provider_store and 'decryptString' in provider_store, 'credential storage must encrypt/decrypt through an injected OS facility')
require('plaintext' in provider_store.lower() or 'encryption' in provider_store.lower(), 'provider store must document fail-closed encryption behavior')
require('redirect' in provider_http.lower() and 'lookup' in provider_http and 'rejectUnauthorized: true' in provider_http, 'provider requests must guard redirects, DNS and TLS')
require('maxResponseBytes' in provider_http and 'REQUEST_TIMEOUT_MS' in provider_http, 'provider HTTP client must bound body and time')
require('AbortSignal' in chat_adapter and 'maxResponseBytes' in chat_adapter, 'model requests must support cancellation and response bounds')
require('maxConcurrent' in worker_runner and 'maxQueued' in worker_runner and 'timeoutMs' in worker_runner, 'Python worker supervision must bound concurrency and time')
require('no target was contacted' in (ROOT / 'src/main/task-service.ts').read_text(encoding='utf-8').lower(), 'blocked investigation modes must state no target was contacted')
require("'rsl-investigation'" in (ROOT / 'src/main/task-service.ts').read_text(encoding='utf-8') and 'prior-art' in rsl_service.lower() or 'target-reuse' in (ROOT / 'resources/reverse-skill-library/SKILL.md').read_text(encoding='utf-8').lower(), 'RSL workflow must preserve target reuse/prior-art prerequisite')
require('runTrustedPythonScript' in rsl_service, 'RSL integration must call the bundled validator/exporter rather than mock results')
require('https://awesome.alexgaoth.com/data.json' in rsl_workflow and 'api.github.com/search/repositories' not in rsl_workflow, 'RSL target reuse must use the required index rather than substitute generic repository search')
require('Search terms are matched locally' in rsl_workflow and 'If-None-Match' in rsl_workflow and 'AWESOME_INDEX_CACHE_TTL_MS' in rsl_workflow, 'RSL index lookup must keep query local and use bounded freshness-aware cache')
require('maxResponseBytes: AWESOME_INDEX_MAX_BYTES' in rsl_workflow and "fitAssessment: 'not_assessed'" in rsl_workflow, 'RSL index response must be bounded and candidate fit must remain unassessed')
require('runTargetApiWorkflow' in (ROOT / 'src/main/agent/runtime.ts').read_text(encoding='utf-8') and 'recordEvidenceArtifact' in target_api_workflow, 'Target API integration must route through runtime and persist evidence artifacts')
require('applied_before_persistence: true' in target_api_workflow and 'onEndpointResult' in target_api_workflow, 'Target API responses must be redacted and persisted before completion checkpoints')
require((ROOT / 'resources/schema/004_approval_details.sql').exists(), 'approval action details migration is missing')
require('Runtime needs setup' in renderer and 'Local workspace · provider traffic follows configuration' in renderer, 'UI must not claim no remote execution or indefinite initialization')
require('RSL investigation' in '\n'.join([main, rsl_service, renderer]), 'RSL workflow must be represented in UI and main runtime')
require('resources/reverse-skill-library' in json.dumps(package['build']['extraResources']), 'bundled RSL resource missing from package recipe')
require('resources/schema' in json.dumps(package['build']['extraResources']), 'SQLite migrations missing from package recipe')
require('workers' in json.dumps(package['build']['extraResources']), 'Python worker scripts missing from package recipe')
require(package['build']['win']['target'] == ['nsis'] and package['build']['win']['artifactName'].endswith('Setup.${ext}'), 'Windows package must emit the named NSIS Setup artifact')
require(package['build']['win'].get('icon') == 'resources/app.ico', 'Windows installer icon is missing')
require('node_modules/better-sqlite3/**' in package['build'].get('asarUnpack', []), 'native SQLite module must be unpacked from ASAR')
require((ROOT / 'scripts/build-windows.ps1').exists(), 'Windows build script is missing')
require((ROOT / '.github/workflows/windows-nsis.yml').exists(), 'Windows NSIS CI workflow is missing')
require('npm run package:win' in (ROOT / '.github/workflows/windows-nsis.yml').read_text(encoding='utf-8'), 'Windows CI must run the package validation/build gate')

migration_versions = []
for sql_file in sorted((ROOT / 'resources/schema').glob('[0-9][0-9][0-9]_*.sql')):
    match = re.match(r'(\d{3})_', sql_file.name)
    if match: migration_versions.append(int(match.group(1)))
require(migration_versions == list(range(1, len(migration_versions) + 1)), 'schema migration files must be sequential without gaps')

if errors:
    for error in errors:
        print(f'FAIL: {error}', file=sys.stderr)
    print(f'{len(errors)} failed of {checks} assertions.', file=sys.stderr)
    raise SystemExit(1)
print(f'PASS: structure/security/persistence/package contracts ({checks} assertions)')
