import { createHash, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile, open, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { RuntimeEvent, TaskStatus } from '@shared/contracts'
import type { TaskCheckpoint, TaskExecutionRecord, TaskStore } from '../task-store.ts'
import type { ProposedOperation } from '../policy.ts'
import { redactSecrets } from '../redaction.ts'
import { resolveProviderEndpoint, requestPinnedHttp, type HostResolver, type ProviderRequest } from '../providers/openai-compatible.ts'
import { resolvePythonRuntime, runTrustedPythonScript } from '../runtime/python-runtime.ts'

const MAX_PROJECT_SCAN_ENTRIES = 3000
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'build', 'release', '.rsl-workbench', '.cache', 'coverage'])
const STOP_WORDS = new Set(['the','a','an','to','for','and','or','of','in','on','at','with','from','by','my','our','this','that','please','investigate','reverse','engineer','analyze','analysis','target','api','application','app','project','key','token','secret','password','credential','authorization','bearer','redacted','api_key','access_token','refresh_token','client_secret','private_key'])

export interface PriorArtResult {
  fullName: string
  url: string
  description: string | null
  updatedAt: string | null
  stars: number | null
  license: string | null
  fitAssessment: 'not_assessed'
  category?: string | null
  subcategory?: string | null
  language?: string | null
  activity?: string | null
  matchedTerms?: string[]
}
export interface PriorArtSearchResult {
  status: 'completed' | 'unavailable'
  observedAtUtc: string
  query: string
  source: string
  totalCount: number | null
  results: PriorArtResult[]
  limitations: string[]
  error?: string
  indexUpdatedAt?: string | null
  indexEntryCount?: number | null
  cacheAgeHours?: number | null
}

export function buildPriorArtQuery(title: string): string {
  const safeTitle = redactSecrets(title ?? '').value
  const terms = safeTitle.normalize('NFKC').match(/[A-Za-z0-9][A-Za-z0-9+_.-]{1,40}/g) ?? []
  const seen = new Set<string>()
  const selected: string[] = []
  for (const term of terms) {
    const value = term.toLowerCase()
    if (STOP_WORDS.has(value) || /^(?:[a-f0-9]{24,}|[a-z0-9_-]{32,})$/i.test(value) || seen.has(value)) continue
    seen.add(value)
    selected.push(term.slice(0, 40))
    if (selected.length >= 8) break
  }
  if (!selected.length) throw new Error('RSL target-reuse search requires a non-sensitive target name or product keyword in the task title.')
  // This text is matched locally against the public index; it is not sent as a search query.
  return selected.join(' ')
}

const AWESOME_INDEX_URL = 'https://awesome.alexgaoth.com/data.json'
const AWESOME_INDEX_MAX_BYTES = 12 * 1024 * 1024
const AWESOME_INDEX_CACHE_TTL_MS = 24 * 60 * 60 * 1000
interface AwesomeIndexEnvelope {
  version: 1
  fetchedAtUtc: string
  etag: string | null
  lastModified: string | null
  payloadSha256: string
  payloadJson: string
}
interface AwesomeIndexPayload {
  meta?: { n?: unknown; updated?: unknown }
  rows?: unknown
}
interface AwesomeIndexEntry {
  slug: string; url: string; title: string; description: string; category: string; subcategory: string;
  stars: number | null; language: string | null; license: string | null; updatedAt: string | null;
  activity: string | null; tags: string[]
}
function isSafeIndexedUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return false
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    // Index entries include self-hosted forge domains (for example, gitlab.freedesktop.org).
    // These URLs are metadata only and are never fetched, cloned or opened automatically.
    if (!host.includes('.') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || isIP(host) !== 0) return false
    return true
  } catch { return false }
}
function parseAwesomeIndex(payloadJson: string): { updatedAt: string | null; rows: AwesomeIndexEntry[] } {
  let payload: AwesomeIndexPayload
  try { payload = JSON.parse(payloadJson) as AwesomeIndexPayload } catch { throw new Error('The awesome-reverse-engineered index returned invalid JSON.') }
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.rows) || !payload.meta || typeof payload.meta !== 'object') {
    throw new Error('The awesome-reverse-engineered index did not match its documented data.json structure.')
  }
  if (payload.rows.length > 100_000) throw new Error('The index entry count exceeded the safety limit.')
  const rows: AwesomeIndexEntry[] = payload.rows.flatMap(raw => {
    if (!Array.isArray(raw) || raw.length < 11) return []
    const [slug, url, title, category, subcategory, stars, language, license, updatedAt, activity, tags] = raw
    if (typeof slug !== 'string' || !slug || slug.length > 200 || !isSafeIndexedUrl(url) || typeof title !== 'string' || !title) return []
    const bounded = (value: unknown, max = 300): string | null => typeof value === 'string' ? redactSecrets(value).value.slice(0, max) : null
    const parsedStars = typeof stars === 'number' && Number.isFinite(stars) && stars >= 0 ? Math.min(stars, 10_000_000) : null
    const parsedTags = Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 50).map(tag => redactSecrets(tag).value.slice(0, 100)) : []
    return [{
      slug: slug.slice(0, 200), url, title: redactSecrets(title).value.slice(0, 500),
      description: redactSecrets(title).value.slice(0, 1000), category: bounded(category, 200) ?? '', subcategory: bounded(subcategory, 200) ?? '',
      stars: parsedStars, language: bounded(language, 100), license: bounded(license, 100), updatedAt: bounded(updatedAt, 50), activity: bounded(activity, 50), tags: parsedTags
    }]
  })
  return { updatedAt: typeof payload.meta.updated === 'string' ? payload.meta.updated.slice(0, 40) : null, rows }
}
function tokenize(value: string): string[] {
  return (redactSecrets(value).value.normalize('NFKC').toLowerCase().match(/[a-z0-9][a-z0-9+_.-]{1,40}/g) ?? []).slice(0, 40)
}
function matchAwesomeIndex(query: string, parsed: { updatedAt: string | null; rows: AwesomeIndexEntry[] }, cacheAgeHours: number | null): PriorArtSearchResult {
  const terms = [...new Set(tokenize(query))].filter(term => !STOP_WORDS.has(term) && !/^(?:[a-f0-9]{24,}|[a-z0-9_-]{32,})$/i.test(term))
  if (!terms.length) throw new Error('Prior-art search has no safe searchable terms after redaction.')
  const scored = parsed.rows.map(entry => {
    const nameField = `${entry.slug} ${entry.title} ${entry.url}`.toLowerCase()
    const descriptionField = entry.description.toLowerCase()
    const tagField = entry.tags.join(' ').toLowerCase()
    const categoryField = `${entry.category} ${entry.subcategory} ${entry.language ?? ''}`.toLowerCase()
    const matchedTerms = terms.filter(term => nameField.includes(term) || descriptionField.includes(term) || tagField.includes(term) || categoryField.includes(term))
    if (!matchedTerms.length) return null
    let score = 0
    for (const term of matchedTerms) {
      if (nameField.includes(term)) score += 8
      if (tagField.includes(term)) score += 5
      if (descriptionField.includes(term)) score += 4
      if (categoryField.includes(term)) score += 2
    }
    const phrase = query.trim().toLowerCase()
    if (phrase.length >= 4 && (entry.title.toLowerCase().includes(phrase) || entry.slug.toLowerCase().includes(phrase))) score += 12
    // Popularity is only a tie-breaker; it does not indicate correctness or safety.
    score += Math.min(2, Math.log10((entry.stars ?? 0) + 1) / 3)
    return { entry, matchedTerms, score }
  }).filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => b.score - a.score || (b.entry.stars ?? 0) - (a.entry.stars ?? 0) || a.entry.slug.localeCompare(b.entry.slug))
  const results: PriorArtResult[] = scored.slice(0, 5).map(({ entry, matchedTerms }) => ({
    fullName: entry.slug,
    url: entry.url,
    description: entry.description || null,
    updatedAt: entry.updatedAt,
    stars: entry.stars,
    license: entry.license,
    fitAssessment: 'not_assessed',
    category: entry.category || null,
    subcategory: entry.subcategory || null,
    language: entry.language,
    activity: entry.activity,
    matchedTerms
  }))
  return {
    status: 'completed', observedAtUtc: new Date().toISOString(), query, source: AWESOME_INDEX_URL,
    totalCount: scored.length, results,
    indexUpdatedAt: parsed.updatedAt, indexEntryCount: parsed.rows.length, cacheAgeHours,
    limitations: [
      'Search terms are matched locally against the public awesome-reverse-engineered index; the query and project files are not sent to the index host.',
      'A match is a candidate only. Repository contents, maintenance, licensing and fit are not independently revalidated, and no candidate is downloaded or executed.',
      'Zero matches means no match was found in this index snapshot and query only; it does not establish uniqueness or absence of prior art.',
      `Source metadata reports index update date ${parsed.updatedAt ?? 'unknown'}; local cache age ${cacheAgeHours === null ? 'not applicable' : `${cacheAgeHours.toFixed(1)} hour(s)`}.`
    ]
  }
}

export async function searchAwesomeReverseEngineeredPriorArt(
  query: string,
  options: { cachePath?: string; resolveHost?: HostResolver; requestImpl?: ProviderRequest; signal?: AbortSignal; now?: () => Date; onBeforeRequest?: (query: string, url: string) => Promise<void>; onAfterRequest?: (disposition: 'known_complete' | 'possible', detail: string) => Promise<void> } = {}
): Promise<PriorArtSearchResult> {
  const safeQuery = buildPriorArtQuery(query)
  const now = options.now ?? (() => new Date())
  const nowDate = now()
  const observedAtUtc = nowDate.toISOString()
  let payloadJson: string | null = null
  let staleEnvelope: AwesomeIndexEnvelope | null = null
  let stalePayloadJson: string | null = null
  let cacheAgeHours: number | null = null
  if (options.cachePath) {
    try {
      const raw = await readFile(options.cachePath, 'utf8')
      const cached = JSON.parse(raw) as AwesomeIndexEnvelope
      if (cached.version === 1 && typeof cached.payloadJson === 'string' && typeof cached.payloadSha256 === 'string' && createHash('sha256').update(cached.payloadJson, 'utf8').digest('hex') === cached.payloadSha256) {
        const fetched = Date.parse(cached.fetchedAtUtc)
        if (Number.isFinite(fetched) && fetched <= nowDate.getTime() + 5 * 60_000 && nowDate.getTime() - fetched >= 0) {
          staleEnvelope = cached
          stalePayloadJson = cached.payloadJson
          cacheAgeHours = (nowDate.getTime() - fetched) / 3_600_000
          if (cacheAgeHours * 3_600_000 <= AWESOME_INDEX_CACHE_TTL_MS) payloadJson = cached.payloadJson
        }
      }
    } catch { /* no usable cache; refresh from the approved source */ }
  }
  if (!payloadJson) {
    const resolved = await resolveProviderEndpoint({ name: 'Public RSL target-reuse index', kind: 'cloud', baseUrl: AWESOME_INDEX_URL, model: 'awesome-reverse-engineered-index' }, options.resolveHost)
    if (!resolved.result) return {
      status: 'unavailable', observedAtUtc, query: safeQuery, source: AWESOME_INDEX_URL, totalCount: null, results: [], cacheAgeHours,
      limitations: ['No public request was sent because the index host failed network policy or DNS validation. Search failure is not evidence that prior art is absent.'],
      error: resolved.error ?? 'Index host could not be safely resolved.'
    }
    await options.onBeforeRequest?.(safeQuery, AWESOME_INDEX_URL)
    let responseReceived = false
    try {
      const requestHeaders: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'RSL-Workbench-Prior-Art/0.2', 'Cache-Control': 'no-cache' }
      if (staleEnvelope?.etag) requestHeaders['If-None-Match'] = staleEnvelope.etag
      if (staleEnvelope?.lastModified) requestHeaders['If-Modified-Since'] = staleEnvelope.lastModified
      const response = await (options.requestImpl ?? requestPinnedHttp)(new URL(AWESOME_INDEX_URL), requestHeaders, 15_000, resolved.result.address, { method: 'GET', maxResponseBytes: AWESOME_INDEX_MAX_BYTES, signal: options.signal })
      responseReceived = true
      await options.onAfterRequest?.('known_complete', `awesome-reverse-engineered index returned HTTP ${response.status}; response status is known.`)
      if (response.status === 304 && staleEnvelope && stalePayloadJson) {
        payloadJson = stalePayloadJson
      } else if (response.status >= 200 && response.status < 300) {
        payloadJson = response.body
      } else return {
        status: 'unavailable', observedAtUtc, query: safeQuery, source: AWESOME_INDEX_URL, totalCount: null, results: [],
        limitations: ['Only the official public index endpoint was queried. A failure cannot establish that prior art is absent.'],
        error: `awesome-reverse-engineered index returned HTTP ${response.status}; no absence-of-prior-art conclusion was made.`
      }
      if (!payloadJson) throw new Error('The index returned an empty response without a verified cache body.')
      // Parse and validate before caching; malformed or adversarial content never replaces a known cache.
      const parsed = parseAwesomeIndex(payloadJson)
      const newEnvelope: AwesomeIndexEnvelope = {
        version: 1, fetchedAtUtc: observedAtUtc, etag: response.headers?.etag ?? staleEnvelope?.etag ?? null,
        lastModified: response.headers?.['last-modified'] ?? staleEnvelope?.lastModified ?? null,
        payloadSha256: createHash('sha256').update(payloadJson, 'utf8').digest('hex'), payloadJson
      }
      if (options.cachePath) {
        await mkdir(dirname(options.cachePath), { recursive: true })
        const temp = `${options.cachePath}.${randomUUID()}.tmp`
        const handle = await open(temp, 'wx', 0o600)
        try { await handle.writeFile(`${JSON.stringify(newEnvelope)}\n`, 'utf8'); await handle.sync() }
        finally { await handle.close() }
        try { await rename(temp, options.cachePath) } catch (error) { await rm(temp, { force: true }).catch(() => undefined); throw error }
      }
      cacheAgeHours = 0
      // Use the parsed object from this just-validated response or revalidated cache below.
      return { ...matchAwesomeIndex(safeQuery, parsed, cacheAgeHours), observedAtUtc, query: safeQuery }
    } catch (error) {
      if (!responseReceived) await options.onAfterRequest?.('possible', 'Index download failed without a verified complete response; reconcile before retrying.')
      return { status: 'unavailable', observedAtUtc, query: safeQuery, source: AWESOME_INDEX_URL, totalCount: null, results: [],
        limitations: ['Search failure is not evidence that prior art is absent. Untrusted or malformed index content is not cached.'],
        error: redactSecrets(error instanceof Error ? error.message : 'Prior-art index download failed.').value.slice(0, 500) }
    }
  }
  try {
    const parsed = parseAwesomeIndex(payloadJson)
    return { ...matchAwesomeIndex(safeQuery, parsed, cacheAgeHours), observedAtUtc, query: safeQuery }
  } catch (error) {
    return { status: 'unavailable', observedAtUtc, query: safeQuery, source: AWESOME_INDEX_URL, totalCount: null, results: [], cacheAgeHours,
      limitations: ['The cached index failed schema validation and was not treated as a successful search.'],
      error: redactSecrets(error instanceof Error ? error.message : 'Prior-art index validation failed.').value.slice(0, 500) }
  }
}

export interface WorkflowContext {
  record: TaskExecutionRecord
  rslRoot: string
  routeScriptPath: string
  state: Omit<TaskCheckpoint, 'taskId' | 'createdAt' | 'schemaVersion'>
  store: TaskStore
  signal: AbortSignal
  setStatus(status: TaskStatus, stage: TaskCheckpoint['stage'], summary?: string): Promise<void>
  event(title: string, detail: string, kind?: RuntimeEvent['kind']): void
  requestApproval(operation: ProposedOperation): Promise<boolean>
  beforeNetwork(detail: string): Promise<void>
  afterNetwork(disposition: 'known_complete' | 'known_not_started' | 'possible', detail: string): Promise<void>
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`
  const file = await open(temp, 'wx', 0o600)
  try { await file.writeFile(content, 'utf8'); await file.sync() } finally { await file.close() }
  try { await rename(temp, path) } catch (error) { await rm(temp, { force: true }).catch(() => undefined); throw error }
}

async function ensureManagedRoot(projectRoot: string, taskId: string): Promise<string> {
  const root = await realpath(projectRoot)
  const managed = join(root, '.rsl-workbench')
  await mkdir(managed, { recursive: true })
  const realManaged = await realpath(managed)
  if (!within(root, realManaged)) throw new Error('Workbench evidence directory resolves outside the registered project root.')
  const cases = join(realManaged, 'cases')
  await mkdir(cases, { recursive: true })
  const realCases = await realpath(cases)
  if (!within(realManaged, realCases)) throw new Error('Workbench case directory resolves outside its managed root.')
  const caseRoot = join(realCases, taskId)
  await mkdir(caseRoot, { recursive: true })
  const realCase = await realpath(caseRoot)
  if (!within(realCases, realCase) || realCase !== caseRoot) throw new Error('Case output path escaped the managed root or was replaced by a symlink.')
  await mkdir(join(realCase, 'evidence', 'records'), { recursive: true })
  return realCase
}

async function writeJson(path: string, value: unknown): Promise<string> {
  const content = `${JSON.stringify(value, null, 2)}\n`
  await atomicWrite(path, content)
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

async function recordEvidence(caseRoot: string, relPath: string, kind: 'input_metadata' | 'tool_output' | 'external_source', locator: string, limitations: string[]): Promise<string> {
  const absolute = join(caseRoot, ...relPath.split('/'))
  const bytes = await readFile(absolute)
  const hash = createHash('sha256').update(bytes).digest('hex')
  const record = {
    artifact_id: randomUUID(), kind, path: relPath, sha256: hash, created_at_utc: new Date().toISOString(),
    source: { type: kind === 'external_source' ? 'web' : kind === 'input_metadata' ? 'manual' : 'command', locator, uri: null, content_version: null },
    toolchain: [{ name: 'RSL Workbench', version: '0.2.0-dev' }], sensitivity: 'internal',
    redaction: { applied_before_persistence: true, ruleset: 'Workbench heuristic secret redaction v1', findings: [], omissions: [] },
    limitations, integrity_note: 'SHA-256 is computed over the exact persisted UTF-8 bytes; this record validates integrity, not truth.'
  }
  await writeJson(join(caseRoot, 'evidence', 'records', `${relPath.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`), record)
  return hash
}

const HARNESS_MARKERS: Array<{ id: string; paths: string[] }> = [
  { id: 'claude-code', paths: ['.claude', 'CLAUDE.md'] }, { id: 'cursor', paths: ['.cursor', '.cursorrules'] },
  { id: 'codex', paths: ['AGENTS.md', '.codex'] }, { id: 'gemini-cli', paths: ['GEMINI.md', '.gemini'] },
  { id: 'copilot', paths: ['.github/copilot-instructions.md', '.github/instructions'] }, { id: 'opencode', paths: ['opencode.json', '.opencode'] },
  { id: 'cline', paths: ['.clinerules', '.clinerules/'] }, { id: 'windsurf', paths: ['.windsurf', '.windsurfrules'] }, { id: 'grok-build', paths: ['.grok'] }
]

async function detectHarness(projectRoot: string): Promise<{ id: string; profileStatus: string; markers: string[] }> {
  const found: string[] = []
  for (const profile of HARNESS_MARKERS) {
    for (const marker of profile.paths) {
      try { await stat(join(projectRoot, marker.replace(/\/$/, ''))); found.push(profile.id); break } catch { /* absent marker */ }
    }
  }
  return found.length === 1 ? { id: found[0] ?? 'generic', profileStatus: 'discovery_hints_only', markers: found } : { id: 'generic', profileStatus: found.length ? 'unknown' : 'unknown', markers: found }
}

async function scanFiles(root: string): Promise<string[]> {
  const found: string[] = []
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  let visited = 0
  while (queue.length && visited < MAX_PROJECT_SCAN_ENTRIES) {
    const current = queue.shift()!
    let entries
    try { entries = await readdir(current.dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (++visited > MAX_PROJECT_SCAN_ENTRIES) break
      if (entry.name.startsWith('.') && current.depth === 0 && IGNORED_DIRS.has(entry.name)) continue
      const fullPath = join(current.dir, entry.name)
      if (entry.isFile()) found.push(relative(root, fullPath).split(sep).join('/'))
      else if (entry.isDirectory() && current.depth < 4 && !IGNORED_DIRS.has(entry.name) && !entry.isSymbolicLink()) queue.push({ dir: fullPath, depth: current.depth + 1 })
    }
  }
  return found
}

const EXTENSION_TOKENS: Record<string, string> = {
  apk: 'apk', aab: 'aab', exe: 'exe', dll: 'dll', so: 'so', elf: 'elf', wasm: 'wasm', jar: 'jar', class: 'class', cil: 'cil',
  dylib: 'macho-native', macho: 'macho', ipa: 'ios_app', app: 'macos_app', pcap: 'pcap', pcapng: 'pcap', asar: 'asar', js: 'javascript_bundle',
  mjs: 'javascript_bundle', cjs: 'javascript_bundle', html: 'web_bundle', firmware: 'firmware', fw: 'firmware', bin: 'embedded_image'
}

function inferFormat(title: string, prompt: string, files: string[]): { format: string | null; basis: string; ambiguous: boolean } {
  const titleAndPrompt = `${title}\n${prompt}`
  const explicit = [...titleAndPrompt.matchAll(/(?:^|[\\/\s"'`(])[^\s"'`<>]*\.([a-zA-Z0-9]+)(?=$|[\s"'`),;:])/g)]
    .map(match => EXTENSION_TOKENS[(match[1] ?? '').toLowerCase()]).filter((token): token is string => Boolean(token))
  const exactUnique = [...new Set(explicit)]
  if (exactUnique.length === 1) return { format: exactUnique[0] ?? null, basis: 'A supported file extension was explicitly named in the task title/prompt; content was not inspected.', ambiguous: false }
  if (exactUnique.length > 1) return { format: null, basis: 'The task text contains multiple supported file-format hints; routing was not guessed.', ambiguous: true }
  const discovered = [...new Set(files.map(path => EXTENSION_TOKENS[path.split('.').at(-1)?.toLowerCase() ?? '']).filter((token): token is string => Boolean(token)))]
  if (discovered.length === 1) return { format: discovered[0] ?? null, basis: 'One supported file-format family was found by bounded filename-only inventory; file contents were not inspected.', ambiguous: false }
  return { format: null, basis: discovered.length > 1 ? 'Multiple supported file-format families were found in the project; target identity is ambiguous.' : 'No supported format hint was found in task text or bounded filename-only inventory.', ambiguous: discovered.length > 1 }
}

export interface RslWorkflowDependencies {
  searchPriorArt?: (query: string, signal: AbortSignal) => Promise<PriorArtSearchResult>
  priorArtCachePath?: string
  now?: () => Date
}

async function validateCaseWithBundledScript(caseRoot: string, rslRoot: string, signal: AbortSignal): Promise<{ passed: boolean; output: string }> {
  const python = resolvePythonRuntime()
  const script = join(rslRoot, 'validation', 'validate_case.py')
  const result = await runTrustedPythonScript({ executable: python.executable, scriptPath: script, args: [caseRoot, '--json'], cwd: rslRoot, timeoutMs: 30_000, maxOutputBytes: 1_000_000, signal })
  return { passed: result.code === 0 && (() => { try { return JSON.parse(result.stdout).status === 'PASS' } catch { return false } })(), output: result.stdout }
}

function targetReuseApproval(record: TaskExecutionRecord, caseRoot: string, priorArt: PriorArtSearchResult): ProposedOperation {
  return {
    id: randomUUID(), kind: 'acknowledge_prior_art',
    summary: `Review ${priorArt.results.length} public prior-art candidate(s) before allowing RSL triage`, target: join(caseRoot, 'target_reuse.json'),
    projectRoot: record.projectRoot,
    parameters: {
      query: priorArt.query,
      candidateUrls: priorArt.results.map(item => item.url),
      searchResultCount: priorArt.totalCount,
      contentPreview: priorArt.results.map(item => `${item.fullName}\n${item.url}\nCategory: ${item.category ?? 'unknown'} · Activity: ${item.activity ?? 'unknown'} · Language: ${item.language ?? 'unknown'}\nUpdated: ${item.updatedAt ?? 'unknown'} · Stars: ${item.stars ?? 'unknown'} · License: ${item.license ?? 'not listed'}\n${item.description ?? 'No description provided'}\nMatched terms: ${(item.matchedTerms ?? []).join(', ') || 'unknown'} · Fit: not assessed`).join('\n\n').slice(0, 80_000)
    },
    expectedImpact: 'Approving allows deterministic RSL triage to run after review of these candidates. It does not install, execute or trust any candidate repository.',
    rollbackInfo: 'No candidate code will be downloaded or executed. Deny this acknowledgement to leave the investigation blocked before triage.'
  }
}

/** Orchestrates RSL capability discovery -> target reuse -> route selection -> case validation. */
export async function runRslInvestigation(context: WorkflowContext, dependencies: RslWorkflowDependencies = {}): Promise<void> {
  const { record, store, signal } = context
  if (context.state.capabilityDetectionRequired === false && context.state.notes.some(note => /case validated/i.test(note))) {
    context.event('RSL checkpoint resumed', 'Existing case artifacts will be revalidated before continuing; no prior model/tool side effect will be replayed.')
  }
  if (context.signal.aborted) throw new Error('RSL investigation cancelled before capability detection.')
  if (record.workflowConfig.priorArtSearchApproved !== true) throw new Error('RSL target-reuse index access lacks explicit main-process approval. No external request was sent.')
  const projectRoot = await realpath(record.projectRoot)
  const caseRoot = await ensureManagedRoot(projectRoot, record.id)
  const now = dependencies.now ?? (() => new Date())
  await context.setStatus('running', 'planning', 'RSL workflow started: capability detection precedes prior-art search and triage.')
  context.event('RSL capability detection started', 'Scanning only bounded project filenames/config markers and Workbench-declared integrations; unsupported features remain unknown.')

  const harness = await detectHarness(projectRoot)
  const files = await scanFiles(projectRoot)
  const format = inferFormat(record.title, record.prompt, files)
  const detection = {
    observed_at_utc: now().toISOString(), project_root_hash: createHash('sha256').update(projectRoot).digest('hex'),
    harness_markers: harness.markers, chosen_harness: harness.id, profile_status: harness.profileStatus,
    supported_file_candidates: files.filter(path => EXTENSION_TOKENS[path.split('.').at(-1)?.toLowerCase() ?? '']).slice(0, 100),
    format_inference: format, files_scanned: Math.min(files.length, MAX_PROJECT_SCAN_ENTRIES),
    integrations: { native_coding_tools: 'available', python_worker: 'available', provider_neutral_chat: 'partial', mcp: 'unavailable', rea: 'unavailable', ghidra_mcp: 'unavailable', commercial_agent_runtime: 'unknown' },
    limitations: ['Harness markers are discovery hints, not proof the corresponding agent is installed or active.', 'Filename-only format inference does not inspect binaries or establish their architecture.', 'No target file has been executed or dynamically instrumented.']
  }
  await mkdir(join(caseRoot, 'evidence'), { recursive: true })
  await writeJson(join(caseRoot, 'evidence', 'capability-scan.json'), detection)
  await recordEvidence(caseRoot, 'evidence/capability-scan.json', 'input_metadata', 'Bounded filename and configuration marker scan', detection.limitations)

  const capabilities = {
    schema_version: '2.0', observed_at_utc: detection.observed_at_utc, snapshot_id: randomUUID(),
    harness: { id: harness.id, version: null, profile_status: harness.profileStatus, evidence_refs: ['evidence/capability-scan.json'], observed_markers: harness.markers },
    capabilities: {
      workspace_file_inventory: { status: 'available', detection_method: 'Bounded filesystem metadata scan', evidence_refs: ['evidence/capability-scan.json'], fallback_state: 'unknown/unsupported file types remain uninspected' },
      provider_chat: { status: 'partial', detection_method: 'Workbench adapter declaration; provider connectivity is separately tested', evidence_refs: ['evidence/capability-scan.json'], fallback_state: 'local diagnostics or explicit blocked state' },
      mcp_client: { status: 'unavailable', detection_method: 'No MCP client is integrated in this build', evidence_refs: ['evidence/capability-scan.json'], fallback_state: 'documented CLI fallback only after user approval' },
      native_reverse_engineering_backend: { status: 'unavailable', detection_method: 'No REA/GhidraMCP executor is integrated in this build', evidence_refs: ['evidence/capability-scan.json'], fallback_state: 'produce a bounded triage plan and report the blocker' },
      parallel_subagents: { status: 'unknown', detection_method: 'No live host-agent delegation probe was run', evidence_refs: ['evidence/capability-scan.json'], fallback_state: 'sequential execution' }
    },
    backend: { status: 'not_applicable', protocol_version: null, lifecycle_mode: 'not_applicable', server_name: null, server_version: null, transport: null, primitives: [], extensions: [], evidence_refs: [] },
    fallback_summary: 'Workbench native tools and Python worker are available; MCP and reverse-engineering backend integrations are unavailable in this build. No capability is inferred from a product adapter name.',
    toolchain: [{ name: 'RSL Workbench', version: '0.2.0-dev', source: 'local application runtime' }],
    profile_warnings: ['Host agent compatibility has not been tested in-product.', 'This capability snapshot is an honest inventory of the Workbench execution environment, not a certificate for a third-party harness.']
  }
  await writeJson(join(caseRoot, 'capabilities.json'), capabilities)
  const capabilitiesStat = await stat(join(caseRoot, 'capabilities.json'))
  context.event('RSL capabilities snapshot saved', `${harness.id} profile · ${Object.keys(capabilities.capabilities).length} capabilities recorded · profile verification: ${harness.profileStatus}.`, 'evidence')

  let priorArt: PriorArtSearchResult
  const savedPriorArtPath = join(caseRoot, 'target_reuse.json')
  try {
    const saved = JSON.parse(await readFile(savedPriorArtPath, 'utf8')) as PriorArtSearchResult & { user_acknowledged_before_triage?: boolean }
    if (saved.status === 'completed' && Array.isArray(saved.results)) priorArt = saved
    else throw new Error('prior-art record requires a retry')
  } catch {
    const query = buildPriorArtQuery(record.title)
    const productionSearch = dependencies.searchPriorArt ?? ((value, taskSignal) => searchAwesomeReverseEngineeredPriorArt(value, {
      cachePath: dependencies.priorArtCachePath, signal: taskSignal, now,
      onBeforeRequest: async (_safeQuery, url) => context.beforeNetwork(`Fetch public awesome-reverse-engineered index from ${redactSecrets(url).value}; the target query remains local.`),
      onAfterRequest: async (disposition, detail) => context.afterNetwork(disposition, detail)
    }))
    priorArt = await productionSearch(query, signal)
    if (priorArt.status === 'unavailable') {
      await writeJson(savedPriorArtPath, { ...priorArt, query_sent: false, query_matched_locally: true, user_acknowledged_before_triage: false })
      await recordEvidence(caseRoot, 'target_reuse.json', 'external_source', priorArt.source, priorArt.limitations)
      const uncertain = context.state.operationInFlight || context.state.sideEffectState === 'possible'
      await context.setStatus(uncertain ? 'outcome_uncertain' : 'blocked', 'planning', `RSL triage is blocked because the prior-art search could not be verified: ${priorArt.error ?? 'search unavailable'}. No claim of absent prior art was made.${uncertain ? ' A remote request may have been received; reconcile before retrying.' : ' Network policy prevented a request or an HTTP response was definitively received.'}`)
      context.event('Prior-art search unavailable', uncertain ? 'A remote request outcome may be uncertain; do not automatically repeat it.' : 'Restore network access or retry the RSL task. Triage was not executed.', 'warning')
      return
    }
  }

  const priorArtRecord = {
    schema_version: '1.0', status: priorArt.status, observedAtUtc: priorArt.observedAtUtc,
    observed_at_utc: priorArt.observedAtUtc, query: priorArt.query,
    source: priorArt.source, search_status: priorArt.status,
    result: priorArt.results.length ? 'candidates_found' : 'no_match_found_in_searched_sources',
    totalCount: priorArt.totalCount, total_count: priorArt.totalCount, results: priorArt.results,
    indexUpdatedAt: priorArt.indexUpdatedAt ?? null, index_updated_at: priorArt.indexUpdatedAt ?? null,
    indexEntryCount: priorArt.indexEntryCount ?? null, index_entry_count: priorArt.indexEntryCount ?? null,
    cacheAgeHours: priorArt.cacheAgeHours ?? null, cache_age_hours: priorArt.cacheAgeHours ?? null,
    user_acknowledged_before_triage: (priorArt as PriorArtSearchResult & { user_acknowledged_before_triage?: boolean }).user_acknowledged_before_triage === true,
    limitations: priorArt.limitations
  }
  await writeJson(savedPriorArtPath, priorArtRecord)
  await recordEvidence(caseRoot, 'target_reuse.json', 'external_source', priorArt.source, priorArt.limitations)
  if (priorArt.results.length > 0 && priorArtRecord.user_acknowledged_before_triage !== true) {
    context.event('Prior-art candidates require review', `Found ${priorArt.results.length} candidate(s) in the awesome-reverse-engineered index. Their fit is not assessed; review them before allowing triage.`, 'warning')
    const approved = await context.requestApproval(targetReuseApproval(record, caseRoot, priorArt))
    if (!approved) {
      await context.setStatus('blocked', 'planning', `Stopped before triage because public prior-art candidate review was not acknowledged. Review ${relative(projectRoot, savedPriorArtPath)} and resume when ready.`)
      context.event('RSL stopped before triage', 'No specialist route was selected because prior-art review was denied or expired.', 'warning')
      return
    }
    priorArtRecord.user_acknowledged_before_triage = true
    ;(priorArtRecord as Record<string, unknown>).acknowledgement_at_utc = now().toISOString()
    await writeJson(savedPriorArtPath, priorArtRecord)
    await recordEvidence(caseRoot, 'target_reuse.json', 'external_source', priorArt.source, [...priorArt.limitations, 'User reviewed candidate metadata and explicitly acknowledged continuing; candidates remain unverified.'])
  }

  if (signal.aborted) throw new Error('RSL investigation cancelled before triage.')
  const routeToken = format.format
  let routing: { status: 'ROUTED' | 'NO_ROUTE'; format: string | null; route_id: string | null; entry: string | null; cross_check: string[]; reason: string }
  if (!routeToken) routing = { status: 'NO_ROUTE', format: null, route_id: null, entry: null, cross_check: [], reason: format.basis }
  else {
    const python = resolvePythonRuntime()
    const routeResult = await runTrustedPythonScript({ executable: python.executable, scriptPath: context.routeScriptPath, args: ['--routing', join(context.rslRoot, 'routing.yaml'), '--format', routeToken], cwd: context.rslRoot, timeoutMs: 5_000, maxOutputBytes: 64 * 1024, signal })
    if (routeResult.code !== 0) throw new Error(`Routing resolver failed (${routeResult.code ?? 'unknown exit'}); the Workbench will not duplicate routing rules in TypeScript.`)
    routing = JSON.parse(routeResult.stdout) as typeof routing
  }
  const triage = {
    status: routing.status, format: routing.format, architecture: null,
    protection_signals: [], selected_entry_skill: routing.entry, selected_cross_check_skills: routing.cross_check,
    route_id: routing.route_id, capability_snapshot_ref: 'capabilities.json', evidence_refs: ['target_reuse.json'],
    limitations: [format.basis, 'This stage performs deterministic route selection only. It does not execute specialist reverse-engineering modules or assert binary semantics.', ...(!priorArt.results.length ? ['No match was found only in the recorded awesome-reverse-engineered index snapshot and local query; the result is not proof that prior art does not exist.'] : ['Candidate repositories were not cloned or executed; fit and safety remain unverified.'])]
  }
  await writeJson(join(caseRoot, 'triage.json'), triage)
  await context.event('RSL triage written', routing.status === 'ROUTED' ? `Route ${routing.route_id} → ${routing.entry}; cross-checks: ${routing.cross_check.join(', ') || 'none'}.` : `NO_ROUTE · ${format.basis}`, routing.status === 'ROUTED' ? 'status' : 'warning')
  const check = await validateCaseWithBundledScript(caseRoot, context.rslRoot, signal)
  if (!check.passed) {
    await context.setStatus('failed', 'verification', `RSL case artifacts failed bundled validation. Details: ${redactSecrets(check.output).value.slice(0, 1200)}`)
    context.event('RSL case validation failed', 'The investigation cannot be marked successful until the evidence/schema issue is repaired.', 'error')
    return
  }
  await context.setStatus('succeeded', 'verification', routing.status === 'ROUTED'
    ? `RSL preflight completed and validated. Route: ${routing.route_id}. Specialist modules were selected but not executed; live backend integration remains unavailable.`
    : 'RSL preflight completed and validated with NO_ROUTE. No specialist module was forced; supply a clearer target format or add a reviewed routing entry.')
  context.event('RSL case validation passed', `Case: ${relative(projectRoot, caseRoot)} · capabilities snapshot, prior-art result, triage, sidecars and SHA-256 checks passed.`, 'evidence')
  store.recordTaskEvent(record.id, 'activity', 'RSL preflight complete', `Validated case at ${relative(projectRoot, caseRoot)}; this is preflight/routing, not completed reverse engineering.`)
}
