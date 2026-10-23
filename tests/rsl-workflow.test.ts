import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildPriorArtQuery, runRslInvestigation, type PriorArtSearchResult } from '../src/main/workflows/rsl-investigation.ts'
import type { TaskExecutionRecord, TaskStore } from '../src/main/task-store.ts'
import type { TaskCheckpoint } from '../src/main/task-store.ts'

const RSL_ROOT = resolve('resources/reverse-skill-library')
const ROUTER = resolve('workers/route_rsl.py')

test('prior-art query uses title-only terms and excludes stop words and high-entropy tokens', () => {
  const query = buildPriorArtQuery('Reverse engineer Acme Player 12345678901234567890123456789012')
  assert.match(query, /Acme Player/)
  assert.doesNotMatch(query, /12345678901234567890123456789012/)
  assert.doesNotMatch(query, /Reverse engineer/)
  assert.throws(() => buildPriorArtQuery('please analyze my target api'), /non-sensitive target name/)
})

test('RSL workflow executes capability snapshot -> prior-art check -> deterministic routing -> actual case validator', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'rsl-workflow-e2e-'))
  const taskId = randomUUID()
  await writeFile(join(projectRoot, 'sample.exe'), 'This is a filename-only routing fixture; it is never executed.', 'utf8')
  const events: Array<{ title: string; detail: string }> = []
  const statuses: string[] = []
  const fakeStore = { recordTaskEvent() { return undefined } }
  const state = { status: 'queued', stage: 'intake', promptRedacted: false, capabilityDetectionRequired: true, priorArtCheckRequired: true, operationInFlight: false, sideEffectState: 'none', completedActions: [], pendingApprovalIds: [], notes: [] } as unknown as Omit<TaskCheckpoint, 'taskId' | 'createdAt' | 'schemaVersion'>
  const record = { id: taskId, projectRoot, title: 'Analyze sample.exe', prompt: 'Analyze sample.exe', mode: 'rsl-investigation', status: 'queued', checkpointVersion: 1, workflowConfig: { priorArtSearchApproved: true } } as TaskExecutionRecord
  const priorArt: PriorArtSearchResult = {
    status: 'completed', observedAtUtc: '2026-10-22T00:00:00.000Z', query: 'sample in:name,description,readme', source: 'https://awesome.alexgaoth.com/data.json', totalCount: 0, results: [],
    limitations: ['Test fixture: public search was injected; no network request was sent.']
  }
  try {
    await runRslInvestigation({
      record, rslRoot: RSL_ROOT, routeScriptPath: ROUTER, state, store: fakeStore as unknown as TaskStore, signal: new AbortController().signal,
      async setStatus(status, stage, summary) { (state as { status: string; stage: string }).status = status; (state as { stage: string }).stage = stage; statuses.push(status); if (summary) events.push({ title: 'status', detail: summary }) },
      event(title, detail) { events.push({ title, detail }) },
      async requestApproval() { return true }, async beforeNetwork() { throw new Error('injected prior-art search should not use network callbacks') }, async afterNetwork() { return undefined }
    }, { searchPriorArt: async () => priorArt })
    assert.equal((state as { status: string }).status, 'succeeded', events.map(event => `${event.title}: ${event.detail}`).join('\n'))
    assert.ok(statuses.includes('running'))
    const caseRoot = join(projectRoot, '.rsl-workbench', 'cases', taskId)
    const capabilities = JSON.parse(await readFile(join(caseRoot, 'capabilities.json'), 'utf8'))
    const reuse = JSON.parse(await readFile(join(caseRoot, 'target_reuse.json'), 'utf8'))
    const triage = JSON.parse(await readFile(join(caseRoot, 'triage.json'), 'utf8'))
    assert.equal(capabilities.schema_version, '2.0')
    assert.equal(reuse.result, 'no_match_found_in_searched_sources')
    assert.equal(reuse.status, 'completed')
    assert.equal(triage.status, 'ROUTED')
    assert.ok(triage.route_id)
    assert.match(events.map(event => event.detail).join('\n'), /not executed/i)
    const files = ['evidence/capability-scan.json', 'target_reuse.json']
    for (const file of files) assert.equal((await readFile(join(caseRoot, 'evidence', 'records', `${file.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`), 'utf8')).length > 0, true)
  } finally { await rm(projectRoot, { recursive: true, force: true }) }
})

test('RSL prior-art candidate path blocks triage until one-shot approval and persists acknowledgement', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'rsl-workflow-ack-'))
  const taskId = randomUUID()
  await writeFile(join(projectRoot, 'sample.exe'), 'fixture', 'utf8')
  const events: string[] = []
  let approvals = 0
  const state = { status: 'queued', stage: 'intake', promptRedacted: false, capabilityDetectionRequired: true, priorArtCheckRequired: true, operationInFlight: false, sideEffectState: 'none', completedActions: [], pendingApprovalIds: [], notes: [] } as unknown as Omit<TaskCheckpoint, 'taskId' | 'createdAt' | 'schemaVersion'>
  const record = { id: taskId, projectRoot, title: 'Analyze sample.exe', prompt: 'Analyze sample.exe', mode: 'rsl-investigation', status: 'queued', checkpointVersion: 1, workflowConfig: { priorArtSearchApproved: true } } as TaskExecutionRecord
  const priorArt: PriorArtSearchResult = { status: 'completed', observedAtUtc: '2026-10-22T00:00:00.000Z', query: 'sample in:name,description,readme', source: 'https://awesome.alexgaoth.com/data.json', totalCount: 1,
    results: [{ fullName: 'example/reimplementation', url: 'https://github.com/example/reimplementation', description: 'Candidate only', updatedAt: null, stars: 1, license: 'MIT', fitAssessment: 'not_assessed' }], limitations: ['Candidate fit is not assessed.'] }
  const fakeStore = { recordTaskEvent() { return undefined } }
  try {
    await runRslInvestigation({ record, rslRoot: RSL_ROOT, routeScriptPath: ROUTER, state, store: fakeStore as unknown as TaskStore, signal: new AbortController().signal,
      async setStatus(status, stage) { (state as { status: string; stage: string }).status = status; (state as { stage: string }).stage = stage },
      event(title) { events.push(title) }, async requestApproval() { approvals++; return false }, async beforeNetwork() {}, async afterNetwork() {} }, { searchPriorArt: async () => priorArt })
    const caseRoot = join(projectRoot, '.rsl-workbench', 'cases', taskId)
    assert.equal(approvals, 1)
    assert.equal((state as { status: string }).status, 'blocked')
    assert.equal(events.includes('RSL stopped before triage'), true)
    await assert.rejects(() => readFile(join(caseRoot, 'triage.json'), 'utf8'), /ENOENT/)
    const saved = JSON.parse(await readFile(join(caseRoot, 'target_reuse.json'), 'utf8'))
    assert.equal(saved.user_acknowledged_before_triage, false)
  } finally { await rm(projectRoot, { recursive: true, force: true }) }
})
