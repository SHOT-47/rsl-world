import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolBroker } from '../src/main/agent/tool-broker.ts'
import type { ProposedOperation } from '../src/main/policy.ts'

async function fixture(approve = false) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'rsl-wb-tool-'))
  const controller = new AbortController()
  const approvals: ProposedOperation[] = []
  const sideEffects: Array<{ disposition: string; detail: string }> = []
  const broker = new ToolBroker({
    taskId: 'task-test', workspaceRoot, signal: controller.signal,
    requestApproval: async operation => { approvals.push(operation); return approve },
    onActivity: () => undefined,
    onBeforeSideEffect: () => undefined,
    onAfterSideEffect: (disposition, detail) => { sideEffects.push({ disposition, detail }) }
  })
  await broker.initialize()
  return { workspaceRoot, controller, approvals, sideEffects, broker, cleanup: () => rm(workspaceRoot, { recursive: true, force: true }) }
}

test('read_file returns text and redacts likely secrets', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.workspaceRoot, 'config.txt'), 'mode=dev\napi_key=supersecretvalue\n')
    const result = await f.broker.execute('read_file', { path: 'config.txt' })
    assert.equal(result.ok, true)
    const output = JSON.stringify(result.output)
    assert.match(output, /\[REDACTED\]/)
    assert.doesNotMatch(output, /supersecretvalue/)
  } finally { await f.cleanup() }
})

test('path traversal and likely-secret filenames are denied', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.broker.execute('read_file', { path: '../outside.txt' })).ok, false)
    assert.equal((await f.broker.execute('read_file', { path: '.env' })).ok, false)
  } finally { await f.cleanup() }
})

test('write_file needs approval and shows exact proposed content', async () => {
  const denied = await fixture(false)
  try {
    await mkdir(join(denied.workspaceRoot, 'src'))
    const result = await denied.broker.execute('write_file', { path: 'src/new.ts', content: 'export const safe = true\n' })
    assert.equal(result.ok, false)
    await assert.rejects(() => readFile(join(denied.workspaceRoot, 'src/new.ts')), /ENOENT/)
    assert.equal(denied.approvals.length, 1)
    assert.equal(denied.approvals[0]?.parameters.contentPreview, 'export const safe = true\n')
  } finally { await denied.cleanup() }
})

test('approved writes are atomic and emit completion checkpoints', async () => {
  const f = await fixture(true)
  try {
    await mkdir(join(f.workspaceRoot, 'src'))
    const result = await f.broker.execute('write_file', { path: 'src/new.ts', content: 'export const safe = true\n' })
    assert.equal(result.ok, true)
    assert.equal(await readFile(join(f.workspaceRoot, 'src/new.ts'), 'utf8'), 'export const safe = true\n')
    assert.deepEqual(f.sideEffects.map(item => item.disposition), ['known_complete'])
  } finally { await f.cleanup() }
})

test('write_file refuses likely secret content without requesting approval', async () => {
  const f = await fixture(true)
  try {
    const result = await f.broker.execute('write_file', { path: 'config.ts', content: 'const api_key = "realSecretMaterial"\n' })
    assert.equal(result.ok, false)
    assert.match(String(result.error), /secret values/i)
    assert.equal(f.approvals.length, 0)
  } finally { await f.cleanup() }
})

test('run_command uses direct argv and exact approval, not a shell', async () => {
  const f = await fixture(true)
  try {
    const result = await f.broker.execute('run_command', { executable: process.execPath, args: ['--version'] })
    assert.equal(result.ok, true)
    assert.equal(f.approvals.length, 1)
    assert.match(JSON.stringify(result.output), /v\d+\./)
    assert.deepEqual(f.sideEffects.map(item => item.disposition), ['known_complete'])
  } finally { await f.cleanup() }
})

test('inline interpreter execution and shell wrappers are blocked', async () => {
  const f = await fixture(true)
  try {
    const inline = await f.broker.execute('run_command', { executable: process.execPath, args: ['-e', 'process.exit(0)'] })
    const shell = await f.broker.execute('run_command', { executable: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', args: ['-c', 'echo unsafe'] })
    assert.equal(inline.ok, false)
    assert.match(String(inline.error), /Inline interpreter/i)
    assert.equal(shell.ok, false)
    assert.match(String(shell.error), /Shell interpreters/i)
    assert.equal(f.approvals.length, 0)
  } finally { await f.cleanup() }
})

test('symlink escape is rejected', { skip: process.platform === 'win32' ? 'Symlink creation may require elevated privileges on Windows.' : false }, async () => {
  const f = await fixture()
  const outsideRoot = await mkdtemp(join(tmpdir(), 'rsl-wb-outside-'))
  try {
    await writeFile(join(outsideRoot, 'secret.txt'), 'private contents')
    await symlink(join(outsideRoot, 'secret.txt'), join(f.workspaceRoot, 'escape.txt'))
    const result = await f.broker.execute('read_file', { path: 'escape.txt' })
    assert.equal(result.ok, false)
    assert.match(String(result.error), /escapes|symlink/i)
  } finally { await f.cleanup(); await rm(outsideRoot, { recursive: true, force: true }) }
})

test('timed-out command records a possible side effect instead of success', async () => {
  const f = await fixture(true)
  try {
    await writeFile(join(f.workspaceRoot, 'slow.js'), 'setTimeout(() => process.exit(0), 4000)\n')
    // The broker enforces a 1s minimum timeout. A timeout is expected to be classified as uncertain.
    const brokerWithShortTimeout = new ToolBroker({
      taskId: 'task-timeout', workspaceRoot: f.workspaceRoot, signal: f.controller.signal,
      requestApproval: async operation => { f.approvals.push(operation); return true },
      onActivity: () => undefined,
      onBeforeSideEffect: () => undefined,
      onAfterSideEffect: (disposition, detail) => { f.sideEffects.push({ disposition, detail }) },
      commandTimeoutMs: 1000
    })
    await brokerWithShortTimeout.initialize()
    const result = await brokerWithShortTimeout.execute('run_command', { executable: process.execPath, args: ['slow.js'] })
    assert.equal(result.ok, true)
    assert.equal((result.output as { status: string }).status, 'timed_out')
    assert.equal(f.sideEffects.at(-1)?.disposition, 'possible')
  } finally { await f.cleanup() }
})
