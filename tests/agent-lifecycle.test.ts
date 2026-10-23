import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentRuntime } from '../src/main/agent/runtime.ts'
import type { TaskStore } from '../src/main/task-store.ts'
import type { ProviderStore } from '../src/main/providers/provider-store.ts'

function createRuntime() {
  const runtime = new AgentRuntime({ store: {} as TaskStore, providers: {} as ProviderStore, rslRoot: '.', onEvent: () => undefined })
  return runtime as unknown as {
    cancelAndWait(timeoutMs?: number): Promise<boolean>
    active: Map<string, AbortController>
    completions: Map<string, Promise<void>>
  }
}

test('safe shutdown aborts tasks and waits for in-flight task promises to settle', async () => {
  const runtime = createRuntime()
  const controller = new AbortController()
  runtime.active.set('task-1', controller)
  let complete!: () => void
  runtime.completions.set('task-1', new Promise<void>(resolve => { complete = resolve }))

  const waiting = runtime.cancelAndWait(500)
  assert.equal(controller.signal.aborted, true)
  let settled = false
  void waiting.then(() => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  complete()
  assert.equal(await waiting, true)
})

test('safe shutdown reports timeout rather than claiming tasks stopped', async () => {
  const runtime = createRuntime()
  const controller = new AbortController()
  runtime.active.set('task-2', controller)
  runtime.completions.set('task-2', new Promise<void>(() => undefined))
  assert.equal(await runtime.cancelAndWait(10), false)
  assert.equal(controller.signal.aborted, true)
})
