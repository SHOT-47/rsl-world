import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const preload = await readFile(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
const security = await readFile(new URL('../src/main/security.ts', import.meta.url), 'utf8')
const contracts = await readFile(new URL('../src/shared/contracts.ts', import.meta.url), 'utf8')
const html = await readFile(new URL('../src/renderer/index.html', import.meta.url), 'utf8')
const rslWorkflow = await readFile(new URL('../src/main/workflows/rsl-investigation.ts', import.meta.url), 'utf8')
const targetApiWorkflow = await readFile(new URL('../src/main/workflows/target-api-workflow.ts', import.meta.url), 'utf8')

test('Electron renderer runs with least-privilege web preferences', () => {
  assert.match(main, /contextIsolation:\s*true/)
  assert.match(main, /nodeIntegration:\s*false/)
  assert.match(main, /sandbox:\s*true/)
  assert.match(main, /webSecurity:\s*true/)
  assert.match(main, /allowRunningInsecureContent:\s*false/)
  assert.match(main, /webviewTag:\s*false/)
})

test('Navigation and new windows are denied by default', () => {
  assert.match(main, /on\('will-navigate'/)
  assert.match(main, /setWindowOpenHandler/)
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{\s*action:\s*'deny'\s*\}\)\)/)
  assert.match(main, /will-attach-webview/)
})

test('Strict CSP is attached and renderer HTML has a fallback CSP', () => {
  assert.match(main, /Content-Security-Policy/)
  assert.match(security, /default-src 'self'/)
  assert.match(security, /object-src 'none'/)
  assert.match(security, /frame-ancestors 'none'/)
  assert.match(html, /http-equiv="Content-Security-Policy"/)
})

test('Every IPC handler validates the calling renderer', () => {
  assert.match(main, /assertTrustedSender/)
  assert.match(main, /function guardSender/)
  assert.match(security, /expectedWebContentsId/)
  assert.match(security, /senderFrame\?\.url/)
  assert.match(security, /isAllowedUrl\(frameUrl\)/)
})

test('Preload exposes specific methods, never a generic IPC escape hatch', () => {
  assert.match(preload, /contextBridge\.exposeInMainWorld\('workbench', api\)/)
  assert.doesNotMatch(preload, /exposeInMainWorld\([^\n]*(ipcRenderer|send|invoke)/)
  assert.doesNotMatch(preload, /\b(send|invoke|on):\s*\(/)
  assert.doesNotMatch(preload, /executeCommand|runShell|exec\(|spawn\(/)
  assert.match(preload, /ipcRenderer\.invoke\(IPC\.getBootstrap\)/)
})

test('IPC contract is allowlisted and has no raw shell/command channel', () => {
  assert.match(contracts, /getBootstrap:\s*'app:get-bootstrap'/)
  assert.match(contracts, /createTask:\s*'task:create'/)
  assert.match(contracts, /respondToApproval:\s*'approval:respond'/)
  assert.doesNotMatch(contracts, /shell:exec|command:run|process:spawn|ipc:raw/)
})

test('Default security policy denies browser permission requests', () => {
  assert.match(main, /setPermissionRequestHandler\([^\n]*callback\(false\)/)
})


test('RSL target reuse uses the required index, local query matching, and bounded verified cache', () => {
  assert.match(rslWorkflow, /https:\/\/awesome\.alexgaoth\.com\/data\.json/)
  assert.match(rslWorkflow, /Search terms are matched locally/)
  assert.match(rslWorkflow, /AWESOME_INDEX_CACHE_TTL_MS/)
  assert.match(rslWorkflow, /If-None-Match/)
  assert.match(rslWorkflow, /maxResponseBytes:\s*AWESOME_INDEX_MAX_BYTES/)
  assert.doesNotMatch(rslWorkflow, /https:\/\/api\.github\.com\/search\/repositories/)
  assert.match(rslWorkflow, /fitAssessment:\s*'not_assessed'/)
})

test('target API integration is explicit-scope and persists redacted evidence before completion', () => {
  assert.match(main, /Authorize read-only Target API investigation/)
  assert.match(targetApiWorkflow, /recordEvidenceArtifact/)
  assert.match(targetApiWorkflow, /onEndpointResult/)
  assert.match(targetApiWorkflow, /applied_before_persistence:\s*true/)
  assert.match(targetApiWorkflow, /no credentials will be sent/i)
})
