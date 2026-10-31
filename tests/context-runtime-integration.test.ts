import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  type CapturedMessage = {
    role: string
    content: string | null
    tool_call_id?: string
    tool_calls?: Array<{ id: string }>
  }
  const capturedMessagesByRequest: CapturedMessage[][] = []
  let requestCount = 0
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const payload = JSON.parse(body) as { messages: CapturedMessage[] }
      capturedMessagesByRequest.push(payload.messages)
      response.writeHead(200, { 'content-type': 'application/json' })
      if (requestCount++ === 0) {
        response.end(JSON.stringify({
          choices: [{
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant', content: null,
              tool_calls: [{
                id: 'call-read-source', type: 'function',
                function: { name: 'read_file', arguments: '{"path":"source.txt"}' }
              }]
            }
          }],
          usage: { prompt_tokens: 31, completion_tokens: 8, total_tokens: 39 }
        }))
      } else {
        response.end(JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Task complete.', tool_calls: [] } }],
          usage: { prompt_tokens: 48, completion_tokens: 4, total_tokens: 52 }
        }))
      }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test provider failed to bind a TCP port.')

  try {
    store.registerProject(workspaceRoot)
    writeFileSync(join(workspaceRoot, 'source.txt'), 'verified test fixture content')
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
      { id: task.id, projectRoot: workspaceRoot, prompt: 'Preserve the current user request.', mode: 'coding' },
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

    assert.equal(capturedMessagesByRequest.length, 2)
    assert.deepEqual(capturedMessagesByRequest[0]!.map(message => message.role), ['system', 'user'])
    assert.equal(capturedMessagesByRequest[0]!.some(message => message.content?.includes('Old archived context must not return.')), false)
    assert.equal(capturedMessagesByRequest[0]![1]?.content, 'Preserve the current user request.')
    const secondRequest = capturedMessagesByRequest[1]!
    assert.deepEqual(secondRequest.map(message => message.role), ['system', 'user', 'assistant', 'tool'])
    assert.equal(secondRequest[2]?.tool_calls?.[0]?.id, 'call-read-source')
    assert.equal(secondRequest[3]?.tool_call_id, 'call-read-source')
    assert.match(secondRequest[3]?.content ?? '', /verified test fixture content/)

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
