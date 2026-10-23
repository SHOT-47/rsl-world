import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { investigateTargetApi, normalizeTargetApiScope } from '../src/main/workflows/target-api.ts'
import { runTargetApiWorkflow } from '../src/main/workflows/target-api-workflow.ts'
import type { TaskExecutionRecord } from '../src/main/task-store.ts'
import type { TaskCheckpoint } from '../src/main/task-store.ts'

const publicResolver = async (_hostname: string) => [{ address: '93.184.216.34', family: 4 }]

test('target API scope accepts explicit relative paths and rejects traversal or query syntax', () => {
  const valid = normalizeTargetApiScope({ baseUrl: 'https://api.example.com/v1/', paths: ['users', '/openapi.json', 'users'], authorizationConfirmed: true })
  assert.equal(valid.baseUrl, 'https://api.example.com/v1')
  assert.deepEqual(valid.paths, ['users', 'openapi.json'])
  assert.throws(() => normalizeTargetApiScope({ baseUrl: 'https://api.example.com', paths: ['../admin'], authorizationConfirmed: true }), /normalized relative paths/)
  assert.throws(() => normalizeTargetApiScope({ baseUrl: 'https://api.example.com', paths: ['users?admin=true'], authorizationConfirmed: true }), /query\/fragment syntax/)
  assert.throws(() => normalizeTargetApiScope({ baseUrl: 'https://api.example.com', paths: ['/absolute'], authorizationConfirmed: false }), /Explicit authorization confirmation/)
})

test('target API scope denies remote HTTP, URL credentials, too many paths and missing consent', () => {
  assert.throws(() => normalizeTargetApiScope({ baseUrl: 'http://api.example.com', paths: [], authorizationConfirmed: true }), /must use HTTPS/)
  assert.throws(() => normalizeTargetApiScope({ baseUrl: 'https://user:pass@api.example.com', paths: [], authorizationConfirmed: true }), /user information/)
  assert.throws(() => normalizeTargetApiScope({ baseUrl: 'https://api.example.com', paths: Array.from({ length: 11 }, (_, i) => `p${i}`), authorizationConfirmed: true }), /at most 10/)
  assert.throws(() => normalizeTargetApiScope({ baseUrl: 'https://api.example.com', paths: [], authorizationConfirmed: false }), /Explicit authorization confirmation/)
})

test('target API requests only GET, does not forward auth or follow redirects, and redacts capture before persistence', async () => {
  const calls: Array<{ url: string; method?: string; headers: Record<string, string> }> = []
  const result = await investigateTargetApi({ baseUrl: 'https://api.example.com/v1', paths: ['openapi.json', 'health'], authorizationConfirmed: true }, {
    resolveHost: publicResolver,
    requestImpl: async (url, headers, _timeout, _address, options) => {
      calls.push({ url: url.toString(), method: options?.method, headers })
      if (url.pathname.endsWith('openapi.json')) return { status: 200, body: '{"openapi":"3.0.0","paths":{"/users":{},"/health":{}},"api_key":"secret-material"}', headers: { 'content-type': 'application/json' } }
      return { status: 302, body: 'redirect', headers: { location: 'https://other.example/secret' } }
    }
  })
  assert.equal(result.requestCount, 2)
  assert.equal(result.successfulCount, 1)
  assert.equal(calls.every(call => call.method === 'GET'), true)
  assert.equal(calls.some(call => Object.keys(call.headers).some(key => /authorization|cookie|api[-_]?key/i.test(key))), false)
  assert.equal(result.endpoints[0]?.openApiVersion, '3.0.0')
  assert.equal(result.endpoints[0]?.discoveredPathCount, 2)
  assert.match(result.endpoints[0]?.safeBody ?? '', /\[REDACTED\]/)
  assert.doesNotMatch(result.endpoints[0]?.safeBody ?? '', /secret-material/)
  assert.equal(result.endpoints[1]?.status, 302)
  assert.match(result.endpoints[1]?.summary ?? '', /redirect was not followed/)
  assert.equal(result.endpoints[1]?.url.startsWith('https://api.example.com/'), true)
})

test('target API network safety rejects private DNS answers before request is sent', async () => {
  let called = false
  await assert.rejects(() => investigateTargetApi({ baseUrl: 'https://api.example.com', paths: [], authorizationConfirmed: true }, {
    resolveHost: async () => [{ address: '10.1.2.3', family: 4 }],
    requestImpl: async () => { called = true; return { status: 200, body: '{}' } }
  }), /network policy denied/)
  assert.equal(called, false)
})

test('target API workflow saves redacted response, sidecar, report and hashes before successful completion', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'rsl-target-api-'))
  const taskId = 'a2dc5e1a-4b26-4a68-8cdb-5917ca1c9a71'
  const events: Array<{ title: string; detail: string }> = []
  const evidence: Array<{ relativePath: string; sha256: string }> = []
  const statuses: string[] = []
  const store = {
    recordEvidenceArtifact(input: { relativePath: string; sha256: string }) { evidence.push(input); return input },
    recordTaskEvent() { return undefined }
  }
  const state = { status: 'queued', stage: 'intake', promptRedacted: false, capabilityDetectionRequired: true, priorArtCheckRequired: false, operationInFlight: false, sideEffectState: 'none', completedActions: [], pendingApprovalIds: [], notes: [] } as unknown as Omit<TaskCheckpoint, 'taskId' | 'createdAt' | 'schemaVersion'>
  const record = { id: taskId, projectRoot, title: 'API smoke test', prompt: 'Inspect the API', mode: 'target-api', status: 'queued', checkpointVersion: 1, workflowConfig: { targetApi: { baseUrl: 'https://api.example.com', paths: ['openapi.json'], authorizationConfirmed: true } } } as TaskExecutionRecord
  try {
    await runTargetApiWorkflow({
      record, state, store: store as never, signal: new AbortController().signal,
      async setStatus(status, _stage, summary) { (state as { status: string }).status = status; statuses.push(status); if (summary) events.push({ title: 'status', detail: summary }) },
      event(title, detail) { events.push({ title, detail }) },
      async beforeNetwork() { (state as { operationInFlight: boolean; sideEffectState: string }).operationInFlight = true; (state as { sideEffectState: string }).sideEffectState = 'possible' },
      async afterNetwork(disposition) { (state as { operationInFlight: boolean; sideEffectState: string }).operationInFlight = disposition === 'possible'; (state as { sideEffectState: string }).sideEffectState = disposition }
    }, normalizeTargetApiScope({ baseUrl: 'https://api.example.com', paths: ['openapi.json'], authorizationConfirmed: true }), {
      resolveHost: publicResolver,
      requestImpl: async () => ({ status: 200, body: '{"openapi":"3.0.0","paths":{},"api_key":"api-secret-material"}', headers: { 'content-type': 'application/json' } }),
      now: () => new Date('2026-10-22T00:00:00.000Z')
    })
    assert.equal((state as { status: string }).status, 'succeeded')
    assert.ok(statuses.includes('running'))
    assert.ok(statuses.includes('succeeded'))
    assert.ok(evidence.some(item => item.relativePath.endsWith('/report.json')))
    assert.ok(evidence.some(item => item.relativePath.endsWith('/response-01.txt')))
    const reportPath = join(projectRoot, '.rsl-workbench', 'target-api', taskId, 'report.json')
    const bodyPath = join(projectRoot, '.rsl-workbench', 'target-api', taskId, 'responses', 'response-01.txt')
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    const body = await readFile(bodyPath, 'utf8')
    assert.equal(report.authHeadersSent, false)
    assert.match(body, /\[REDACTED\]/)
    assert.doesNotMatch(body, /api-secret-material/)
    assert.equal((await stat(join(projectRoot, '.rsl-workbench', 'target-api', taskId, 'evidence', 'records', 'E-01.json'))).isFile(), true)
    assert.ok(events.some(event => /Target API report completed/.test(event.title)))
  } finally { await rm(projectRoot, { recursive: true, force: true }) }
})

test('target API workflow stops as outcome_uncertain after a transport failure and will not continue paths', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'rsl-target-uncertain-'))
  const taskId = 'ce8e25f3-fd84-4613-b70e-0f6f80423a0e'
  const state = { status: 'queued', stage: 'intake', promptRedacted: false, capabilityDetectionRequired: true, priorArtCheckRequired: false, operationInFlight: false, sideEffectState: 'none', completedActions: [], pendingApprovalIds: [], notes: [] } as unknown as Omit<TaskCheckpoint, 'taskId' | 'createdAt' | 'schemaVersion'>
  let calls = 0
  const store = { recordEvidenceArtifact() { return undefined }, recordTaskEvent() { return undefined } }
  try {
    await runTargetApiWorkflow({
      record: { id: taskId, projectRoot, title: 'uncertain', prompt: 'test', mode: 'target-api', status: 'queued', checkpointVersion: 1, workflowConfig: {} },
      state, store: store as never, signal: new AbortController().signal,
      async setStatus(status) { (state as { status: string }).status = status }, event() {},
      async beforeNetwork() { (state as { operationInFlight: boolean; sideEffectState: string }).operationInFlight = true; (state as { sideEffectState: string }).sideEffectState = 'possible' },
      async afterNetwork(disposition) { (state as { operationInFlight: boolean; sideEffectState: string }).operationInFlight = disposition === 'possible'; (state as { sideEffectState: string }).sideEffectState = disposition }
    }, normalizeTargetApiScope({ baseUrl: 'https://api.example.com', paths: ['one', 'two'], authorizationConfirmed: true }), {
      resolveHost: publicResolver,
      requestImpl: async () => { calls += 1; throw new Error('connection timeout') }
    })
    assert.equal(calls, 1)
    assert.equal((state as { status: string }).status, 'outcome_uncertain')
  } finally { await rm(projectRoot, { recursive: true, force: true }) }
})
