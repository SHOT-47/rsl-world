import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PythonWorkerRunner } from '../src/main/runtime/python-worker.ts'

const ROOT = resolve('.')
const WORKER = join(ROOT, 'workers', 'protocol.py')
const PYTHON = execFileSync(process.platform === 'win32' ? 'where' : 'which', [process.platform === 'win32' ? 'python' : 'python3'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]

async function fixture() {
  const temp = await mkdtemp(join(tmpdir(), 'rsl-worker-'))
  const workspace = join(temp, 'workspace')
  await mkdir(workspace)
  await writeFile(join(workspace, 'sample.txt'), 'hello\napi_key=sk-abcdefghijklmnopqrstuvwxyz123456\n')
  return { temp, workspace }
}

function runner(workspace: string, extra: Record<string, unknown> = {}) {
  return new PythonWorkerRunner({
    pythonExecutable: PYTHON,
    workerScriptPath: WORKER,
    isWorkspaceAllowed: async (candidate) => {
      // Windows realpath may return an 8.3 path and casing that differs from the selected path.
      const [canonicalCandidate, canonicalWorkspace] = await Promise.all([realpath(candidate), realpath(workspace)])
      return process.platform === 'win32'
        ? canonicalCandidate.toLocaleLowerCase('en-US') === canonicalWorkspace.toLocaleLowerCase('en-US')
        : canonicalCandidate === canonicalWorkspace
    },
    ...extra
  })
}

test('Python worker ping returns a versioned response bound to the request ID', async () => {
  const { temp, workspace } = await fixture()
  try {
    const response = await runner(workspace).run({ operation: 'ping', id: 'ping-1' })
    assert.equal(response.ok, true)
    assert.equal(response.id, 'ping-1')
    assert.equal(response.protocolVersion, 1)
    assert.equal((response.data as { worker: string }).worker, 'rsl-python-worker')
  } finally { await rm(temp, { recursive: true, force: true }) }
})

test('hash_file returns stable SHA-256 and only a workspace-relative path', async () => {
  const { temp, workspace } = await fixture()
  try {
    const response = await runner(workspace).run({ operation: 'hash_file', workspaceRoot: workspace, path: 'sample.txt' })
    assert.equal(response.ok, true)
    const data = response.data as { relativePath: string; sha256: string; sizeBytes: number }
    assert.equal(data.relativePath, 'sample.txt')
    assert.match(data.sha256, /^[a-f0-9]{64}$/)
    assert.equal(data.sizeBytes, (await readFile(join(workspace, 'sample.txt'))).byteLength)
  } finally { await rm(temp, { recursive: true, force: true }) }
})

test('read_text_preview redacts likely secrets before returning data', async () => {
  const { temp, workspace } = await fixture()
  try {
    const response = await runner(workspace).run({ operation: 'read_text_preview', workspaceRoot: workspace, path: 'sample.txt', maxBytes: 4096 })
    assert.equal(response.ok, true)
    const text = (response.data as { text: string }).text
    assert.doesNotMatch(text, /sk-abcdefghijklmnopqrstuvwxyz123456/)
    assert.match(text, /REDACTED/)
  } finally { await rm(temp, { recursive: true, force: true }) }
})

test('worker rejects path traversal and absolute paths', async () => {
  const { temp, workspace } = await fixture()
  try {
    await assert.rejects(runner(workspace).run({ operation: 'hash_file', workspaceRoot: workspace, path: '../outside.txt' }), /escapes the selected workspace/)
    await assert.rejects(runner(workspace).run({ operation: 'hash_file', workspaceRoot: workspace, path: join(workspace, 'sample.txt') }), /workspace-relative/)
  } finally { await rm(temp, { recursive: true, force: true }) }
})

test('worker rejects symlink escape even when the path looks workspace-relative', async (t) => {
  if (process.platform === 'win32') { t.skip('Symlink creation requires platform-specific privileges on Windows.'); return }
  const { temp, workspace } = await fixture()
  try {
    const external = join(temp, 'external.txt')
    await writeFile(external, 'outside workspace')
    await symlink(external, join(workspace, 'escape.txt'))
    const result = await runner(workspace).run({ operation: 'hash_file', workspaceRoot: workspace, path: 'escape.txt' })
    assert.equal(result.ok, false)
    assert.equal(result.error?.code, 'PATH_DENIED')
  } finally { await rm(temp, { recursive: true, force: true }) }
})

test('worker refuses an unregistered workspace before launching analysis', async () => {
  const { temp, workspace } = await fixture()
  try {
    const service = new PythonWorkerRunner({ pythonExecutable: PYTHON, workerScriptPath: WORKER, isWorkspaceAllowed: () => false })
    await assert.rejects(service.run({ operation: 'hash_file', workspaceRoot: workspace, path: 'sample.txt' }), /unregistered workspace/)
  } finally { await rm(temp, { recursive: true, force: true }) }
})

test('worker honors pre-aborted cancellation without starting a process', async () => {
  const { temp, workspace } = await fixture()
  try {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(runner(workspace).run({ operation: 'ping' }, controller.signal), /cancelled before start/)
  } finally { await rm(temp, { recursive: true, force: true }) }
})

test('worker supervisor times out a wedged worker and releases capacity', async () => {
  const { temp, workspace } = await fixture()
  const slowWorker = join(temp, 'slow.py')
  try {
    await writeFile(slowWorker, 'import time\ntime.sleep(5)\n')
    const service = new PythonWorkerRunner({ pythonExecutable: PYTHON, workerScriptPath: slowWorker, isWorkspaceAllowed: () => true, defaultTimeoutMs: 100, maxConcurrent: 1 })
    await assert.rejects(service.run({ operation: 'ping' }), /timed out after 100 ms/)
    const response = await runner(workspace).run({ operation: 'ping' })
    assert.equal(response.ok, true)
  } finally { await rm(temp, { recursive: true, force: true }) }
})
