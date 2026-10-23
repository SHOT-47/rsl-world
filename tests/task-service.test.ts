import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskService } from '../src/main/task-service.ts'
import type { TaskStore } from '../src/main/task-store.ts'

class FakeStore {
  roots = new Set<string>()
  created: unknown = null
  registerProject(root: string) { this.roots.add(root); return { root, displayName: 'project', rslVersionPin: '3.1.0-remediated' } }
  hasProject(root: string) { return this.roots.has(root) }
  listTasks() { return [] }
  createTask(input: unknown, availability: unknown) {
    this.created = { input, availability }
    return { id: 'b3c9fcb4-45c8-4d0a-8b66-a64e4a2fc49a', projectRoot: (input as any).projectRoot, title: (input as any).title, mode: (input as any).mode, status: 'blocked', createdAt: 'now', updatedAt: 'now', checkpointVersion: 1, summary: (availability as any).reason }
  }
  cancelTask(id: string) { return { accepted: true, status: 'cancelled' } }
  decideApproval(id: string, decision: string) { return decision === 'approve' }
}

async function usingService(fn: (service: TaskService, root: string, store: FakeStore) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'rsl-workbench-test-'))
  const store = new FakeStore()
  const service = new TaskService(store as unknown as TaskStore)
  try { await fn(service, root, store) } finally { await rm(root, { recursive: true, force: true }) }
}

test('project registration canonicalizes a real directory and rejects a relative path', async () => {
  await usingService(async (service, root, store) => {
    const registered = await service.registerProjectRoot(root)
    const canonicalRoot = await realpath(root)
    assert.equal(registered.root, canonicalRoot)
    assert.equal(store.hasProject(canonicalRoot), true)
    await assert.rejects(() => service.registerProjectRoot('relative/path'), /absolute path/)
  })
})

test('task creation requires a registered project and valid mode/size-limited input', async () => {
  await usingService(async (service, root, store) => {
    await assert.rejects(() => service.createTask({ projectRoot: root, title: 'x', prompt: 'hello', mode: 'coding' }), /register the project/)
    await service.registerProjectRoot(root)
    const created = await service.createTask({ projectRoot: root, title: 'investigation', prompt: 'analyze package', mode: 'rsl-investigation' })
    assert.equal(created.status, 'blocked')
    assert.equal((store.created as any).availability.ready, false)
    assert.equal((store.created as any).input.mode, 'rsl-investigation')
    await assert.rejects(() => service.createTask({ projectRoot: root, title: 'x', prompt: 'prompt', mode: 'unknown' }), /Unsupported task mode/)
    await assert.rejects(() => service.createTask({ projectRoot: root, title: 'x', prompt: 'x'.repeat(30001), mode: 'coding' }), /exceeds 30000/)
  })
})

test('task cancel and approval decisions validate identifiers and enumerated decision', async () => {
  await usingService(async (service) => {
    assert.throws(() => service.cancelTask({ taskId: 'not-a-uuid' }), /Invalid task identifier/)
    assert.equal(service.cancelTask({ taskId: 'b3c9fcb4-45c8-4d0a-8b66-a64e4a2fc49a' }).accepted, true)
    assert.throws(() => service.respondToApproval({ requestId: 'bad', decision: 'approve' }), /Invalid approval identifier/)
    assert.throws(() => service.respondToApproval({ requestId: 'b3c9fcb4-45c8-4d0a-8b66-a64e4a2fc49a', decision: 'maybe' }), /must be approve or deny/)
  })
})
