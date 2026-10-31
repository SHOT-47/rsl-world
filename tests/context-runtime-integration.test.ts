import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRuntime } from '../src/main/agent/runtime.ts'
import { TaskStore } from '../src/main/task-store.ts'

test('agent requests are rebuilt from the active snapshot and archived records stay archived after resume sync', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'rsl-context-runtime-'))
  const workspaceRoot = join(tempRoot, 'workspace')
  mkdirSync(workspaceRoot, { recursive: true })
  const store = new TaskStore(join(tempRoot, 'workbench.sqlite'), join(process.cwd(), 'resources/schema/001_initial.sql'))
  const boundary = {
    checkpointDurable: true, operationInFlight: false,
    sideEffectState: 'none' as const, pendingApprovalCount: 0
  }
  let capturedMessages: Array<{ role: string; content: string | null }> = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const payload = JSON.parse(body) as { messages: Array<{ role: string; content: string | null }> }
      capturedMessages = payload.messages
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Task complete.', tool_calls: [] } }],
        usage: { prompt_tokens: 31, completion_tokens: 4, total_tokens: 35 }
      }))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test provider failed to bind a TCP port.')

  try {
    store.registerProject(workspaceRoot)
    const task = store.createTask({
      projectRoot: workspaceRoot, title: 'Snapshot lifecycle test',
      prompt: 'Preserve the current user request.', mode: 'coding'
    }, { ready: true })

    const archived = store.appendContextRecord(task.id, {
      kind: 'conversation_message', preservation: 'P4',
      text: JSON.stringify({ role: 'assistant', content: 'Old archived context must not return.' }),
      sourceRefs: ['old-transcript:message']
    }, false)
    const proposed = store.createContextSnapshot(task.id, {
      expectedActiveVersion: 0, activeRecordIds: [], archivedRecordIds: [archived.id],
      reason: 'Fixture: archive one reconstructible old note.',
      auditPassed: true, boundary
    })
    store.activateContextSnapshot(task.id, proposed.version, 0, boundary, true)

    const runtime = new AgentRuntime({
      store, providers: {} as never, rslRoot: '.', onEvent: () => undefined
    })
    const invoke = runtime as unknown as {
      runTask: (
        record: { id: string; projectRoot: string; prompt: string; mode: 'coding' },
        provider: { id: string; name: string; kind: 'local'; baseUrl: string; model: string; apiKey: null },
        state: {
          status: 'queued'; stage: 'planning'; promptRedacted: boolean;
          capabilityDetectionRequired: boolean; priorArtCheckRequired: boolean;
          operationInFlight: boolean; sideEffectState: 'none';
          completedActions: string[]; pendingApprovalIds: string[]; notes: string[]
        },
        signal: AbortSignal
      ) => Promise<void>
    }
    await invoke.runTask(
      { id: task.id, projectRoot: workspaceRoot, prompt: task.prompt, mode: 'coding' },
      {
        id: 'provider-test', name: 'loopback-test', kind: 'local',
        baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'test-model', apiKey: null
      },
      {
        status: 'queued', stage: 'planning', promptRedacted: false,
        capabilityDetectionRequired: true, priorArtCheckRequired: false,
        operationInFlight: false, sideEffectState: 'none',
        completedActions: [], pendingApprovalIds: [], notes: []
      },
      new AbortController().signal
    )

    assert.deepEqual(capturedMessages.map(message => message.role), ['system', 'user'])
    assert.equal(capturedMessages.some(message => message.content?.includes('Old archived context must not return.')), false)
    assert.equal(capturedMessages[1]?.content, 'Preserve the current user request.')

    const active = store.getActiveContextSnapshot(task.id)
    assert.ok(active)
    assert.deepEqual(active.archivedRecordIds, [archived.id])
    const activeRecords = active.activeRecordIds.map(id => store.listContextRecords(task.id).find(record => record.id === id))
    assert.ok(activeRecords.some(record => record?.text.includes('Preserve the current user request.')))
    assert.ok(activeRecords.some(record => record?.text.includes('Task complete.')))
    const checkpoint = store.getLatestCheckpoint(task.id)
    assert.ok(checkpoint)
    assert.equal((JSON.parse(checkpoint.state_json) as { status: string }).status, 'succeeded')
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    store.close()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
