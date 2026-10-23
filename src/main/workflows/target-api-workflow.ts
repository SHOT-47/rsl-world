import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { RuntimeEvent, TaskStatus } from '@shared/contracts'
import type { TaskCheckpoint, TaskExecutionRecord, TaskStore } from '../task-store.ts'
import { redactSecrets } from '../redaction.ts'
import { investigateTargetApi, type NormalizedTargetApiScope, type TargetApiEndpointResult, type TargetApiInvestigationResult } from './target-api.ts'
import type { HostResolver, ProviderRequest } from '../providers/openai-compatible.ts'

type State = Omit<TaskCheckpoint, 'taskId' | 'createdAt' | 'schemaVersion'>

export interface TargetApiWorkflowContext {
  record: TaskExecutionRecord
  state: State
  store: TaskStore
  signal: AbortSignal
  setStatus(status: TaskStatus, stage: TaskCheckpoint['stage'], summary?: string): Promise<void>
  event(title: string, detail: string, kind?: RuntimeEvent['kind']): void
  beforeNetwork(detail: string): Promise<void>
  afterNetwork(disposition: 'known_complete' | 'known_not_started' | 'possible', detail: string): Promise<void>
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(`../`) && !rel.startsWith(`..\\`) && !rel.startsWith(sep))
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`
  const file = await open(temp, 'wx', 0o600)
  try { await file.writeFile(content, 'utf8'); await file.sync() } finally { await file.close() }
  try { await rename(temp, path) } catch (error) { await rm(temp, { force: true }).catch(() => undefined); throw error }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function ensureTargetRoot(projectRoot: string, taskId: string): Promise<string> {
  const root = await realpath(projectRoot)
  const managedPath = join(root, '.rsl-workbench')
  await mkdir(managedPath, { recursive: true })
  const managed = await realpath(managedPath)
  if (!within(root, managed) || managed !== managedPath) throw new Error('Target API evidence root is symlinked or resolves outside the registered project folder.')
  const targetsPath = join(managed, 'target-api')
  await mkdir(targetsPath, { recursive: true })
  const targets = await realpath(targetsPath)
  if (!within(managed, targets) || targets !== targetsPath) throw new Error('Target API output directory is symlinked or escaped its managed root.')
  const caseRoot = join(targets, taskId)
  await mkdir(caseRoot, { recursive: true })
  const actual = await realpath(caseRoot)
  if (!within(targets, actual) || actual !== caseRoot) throw new Error('Target API task directory was replaced or escaped its managed root.')
  for (const child of ['responses', 'evidence/records']) await mkdir(join(actual, child), { recursive: true })
  for (const child of ['responses', 'evidence', 'evidence/records']) {
    const candidate = join(actual, child)
    const resolved = await realpath(candidate)
    if (!within(actual, resolved) || resolved !== candidate) throw new Error(`Target API output path '${child}' is symlinked or escaped its task directory.`)
  }
  return actual
}

function reportableEndpoint(endpoint: TargetApiEndpointResult): Omit<TargetApiEndpointResult, 'safeBody'> {
  const { safeBody: _safeBody, ...rest } = endpoint
  return rest
}

async function registerArtifact(context: TargetApiWorkflowContext, projectRoot: string, caseRoot: string, absolutePath: string): Promise<void> {
  const root = await realpath(projectRoot)
  const actual = await realpath(absolutePath)
  if (!within(root, actual)) throw new Error('Refusing to register evidence outside the selected project folder.')
  const info = await stat(actual)
  if (!info.isFile()) throw new Error('Evidence artifact is not a regular file.')
  const bytes = await readFile(actual)
  const rel = relative(root, actual).split(sep).join('/')
  context.store.recordEvidenceArtifact({
    projectRoot: root, taskId: context.record.id, relativePath: rel,
    name: rel.split('/').at(-1) ?? 'evidence', suffix: rel.split('.').at(-1) ?? '',
    sizeBytes: info.size, modifiedAt: info.mtime.toISOString(),
    sha256: createHash('sha256').update(bytes).digest('hex'), headerHex: bytes.subarray(0, 32).toString('hex')
  })
  void caseRoot
}

async function persistEndpoint(context: TargetApiWorkflowContext, projectRoot: string, caseRoot: string, endpoint: TargetApiEndpointResult, index: number, resultBase: Omit<TargetApiInvestigationResult, 'endpoints' | 'requestCount' | 'successfulCount'>, prior: TargetApiEndpointResult[]): Promise<void> {
  const prefix = String(index).padStart(2, '0')
  if (endpoint.safeBody.length > 0) {
    const responseRel = `responses/response-${prefix}.txt`
    const responsePath = join(caseRoot, responseRel)
    await atomicWrite(responsePath, endpoint.safeBody)
    const contentBytes = Buffer.from(endpoint.safeBody, 'utf8')
    const hash = createHash('sha256').update(contentBytes).digest('hex')
    const metadata = {
      artifact_id: randomUUID(), kind: 'capture', path: `responses/response-${prefix}.txt`, sha256: hash,
      created_at_utc: new Date().toISOString(), source: { type: 'web', locator: endpoint.url, uri: endpoint.url, content_version: endpoint.status === null ? null : `HTTP ${endpoint.status}` },
      toolchain: [{ name: 'RSL Workbench Target API workflow', version: '0.2.0-dev' }], sensitivity: 'internal',
      redaction: { applied_before_persistence: true, ruleset: 'Workbench heuristic secret redaction v1', findings: ['Heuristic redaction applied before persistence; not guaranteed to identify every secret.'], omissions: endpoint.bodyTruncated ? ['Response body truncated to the configured persistence limit.'] : [] },
      limitations: ['Only explicitly authorized unauthenticated GET path.', 'No redirects followed.', 'Hash covers the exact redacted bytes persisted, not the original raw response.'],
      integrity_note: 'SHA-256 confirms the persisted redacted bytes only; it does not prove the response is authentic beyond TLS/endpoint controls.'
    }
    await writeJson(join(caseRoot, 'evidence', 'records', `E-${prefix}.json`), metadata)
    await registerArtifact(context, projectRoot, caseRoot, responsePath)
    await registerArtifact(context, projectRoot, caseRoot, join(caseRoot, 'evidence', 'records', `E-${prefix}.json`))
  }
  const endpoints = [...prior, endpoint]
  await writeJson(join(caseRoot, 'report.partial.json'), {
    schemaVersion: '1.0', taskId: context.record.id, observedAtUtc: resultBase.observedAtUtc,
    baseUrl: resultBase.baseUrl, method: 'GET', authHeadersSent: false, redirectPolicy: 'do_not_follow',
    endpointCount: endpoints.length, endpoints: endpoints.map(reportableEndpoint), limitations: resultBase.limitations,
    reportStatus: endpoint.status === null ? 'outcome_uncertain' : 'in_progress'
  })
}

export async function runTargetApiWorkflow(context: TargetApiWorkflowContext, scope: NormalizedTargetApiScope | undefined, dependencies: { resolveHost?: HostResolver; requestImpl?: ProviderRequest; now?: () => Date } = {}): Promise<void> {
  if (!scope || scope.authorizationConfirmed !== true) throw new Error('Target API workflow has no normalized, explicitly authorized scope. No request was sent.')
  const projectRoot = await realpath(context.record.projectRoot)
  const caseRoot = await ensureTargetRoot(projectRoot, context.record.id)
  const endpoints: TargetApiEndpointResult[] = []
  await context.setStatus('running', 'planning', `Read-only target API investigation prepared for ${scope.baseUrl}; ${scope.paths.length} explicit path(s); no credentials will be sent.`)
  context.event('Target API scope accepted', `Base URL: ${scope.baseUrl}\nMethod: GET only\nPaths: ${scope.paths.join(', ') || '(base path)'}\nAuthorization: operator-confirmed and native approval recorded.`, 'status')

  const result = await investigateTargetApi(scope, {
    ...dependencies,
    signal: context.signal,
    onBeforeRequest: async (path, url) => context.beforeNetwork(`Authorized target API GET ${url}; path '${path}' under the operator-approved origin.`),
    onEndpointResult: async (endpoint, index) => {
      // Save body + evidence metadata + a partial report before marking the request checkpoint complete.
      const base = { schemaVersion: '1.0' as const, observedAtUtc: new Date().toISOString(), baseUrl: scope.baseUrl, method: 'GET' as const, authHeadersSent: false as const, redirectPolicy: 'do_not_follow' as const, limitations: [
        'Only operator-listed paths were requested; OpenAPI-discovered paths are not followed automatically.',
        'No authentication material, cookies, writes, fuzzing or mutation verbs are sent.',
        'Response bodies are heuristic-redacted before persistence; some secrets or personal data may be missed.'
      ] }
      await persistEndpoint(context, projectRoot, caseRoot, endpoint, index, base, endpoints)
      endpoints.push(endpoint)
      context.event('Target API response captured', `${endpoint.path || '(base path)'} · ${endpoint.status === null ? 'outcome uncertain' : `HTTP ${endpoint.status}`} · SHA-256 ${endpoint.sha256 ?? 'unavailable'} · secret-redacted capture persisted.`, endpoint.status === null ? 'warning' : 'evidence')
    },
    onAfterRequest: async (_path, disposition, detail) => context.afterNetwork(disposition, detail)
  })

  const finalReport = {
    ...result,
    endpoints: result.endpoints.map(reportableEndpoint),
    reportStatus: result.endpoints.some(item => item.status === null) ? 'outcome_uncertain' : 'completed',
    limitations: [...result.limitations, 'This is an initial read-only API observation workflow; it does not perform authenticated calls, schema fuzzing, crawling, or mutation testing.']
  }
  const finalPath = join(caseRoot, 'report.json')
  await writeJson(finalPath, finalReport)
  await registerArtifact(context, projectRoot, caseRoot, finalPath)
  try { await rm(join(caseRoot, 'report.partial.json'), { force: true }) } catch { /* final report remains authoritative */ }

  if (result.endpoints.some(item => item.status === null) || context.state.operationInFlight || context.state.sideEffectState === 'possible') {
    await context.setStatus('outcome_uncertain', 'verification', 'At least one GET ended without a verified HTTP response. The redacted partial report is saved, but the remote outcome must be reconciled before retrying.')
    context.event('Target API task stopped for reconciliation', 'A transport error may occur after a server has received a request. Workbench will not automatically repeat the uncertain request.', 'warning')
    return
  }
  const successful = result.successfulCount
  const count = result.endpoints.length
  await context.setStatus('succeeded', 'verification', `Read-only target API observation complete: ${successful}/${count} explicit GET(s) returned 2xx. Redacted evidence and hashes were persisted to ${relative(projectRoot, finalPath)}. HTTP status does not establish application correctness or authorization beyond the operator assertion.`)
  context.event('Target API report completed', `${count} explicit request(s), ${successful} 2xx response(s). ${relative(projectRoot, finalPath)} · no redirects followed · no credentials sent.`, 'evidence')
}
