import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import type { TargetApiScopeInput } from '@shared/contracts'
import { redactSecrets } from '../redaction.ts'
import {
  requestPinnedHttp,
  resolveProviderEndpoint,
  type HostResolver,
  type ProviderRequest,
  type ProviderHttpResponse
} from '../providers/openai-compatible.ts'

const MAX_PATHS = 10
const MAX_RESPONSE_BYTES = 512 * 1024
const MAX_PERSISTED_BODY_BYTES = 256 * 1024
const REQUEST_TIMEOUT_MS = 8_000

export interface NormalizedTargetApiScope extends TargetApiScopeInput {
  baseUrl: string
  paths: string[]
}

export interface TargetApiEndpointResult {
  path: string
  url: string
  status: number | null
  latencyMs: number
  contentType: string | null
  responseBytes: number
  sha256: string | null
  ok: boolean
  summary: string
  responsePreview: string
  safeBody: string
  bodyTruncated: boolean
  openApiVersion: string | null
  discoveredPathCount: number
  discoveredPathSamples: string[]
}

export interface TargetApiInvestigationResult {
  schemaVersion: '1.0'
  observedAtUtc: string
  baseUrl: string
  method: 'GET'
  authHeadersSent: false
  redirectPolicy: 'do_not_follow'
  requestCount: number
  successfulCount: number
  endpoints: TargetApiEndpointResult[]
  limitations: string[]
}

export interface TargetApiOptions {
  resolveHost?: HostResolver
  requestImpl?: ProviderRequest
  signal?: AbortSignal
  timeoutMs?: number
  now?: () => Date
  onBeforeRequest?: (path: string, url: string) => Promise<void>
  onAfterRequest?: (path: string, disposition: 'known_complete' | 'possible', detail: string) => Promise<void>
  onEndpointResult?: (endpoint: TargetApiEndpointResult, index: number, total: number) => Promise<void>
}

function loopbackHost(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (value === 'localhost' || value.endsWith('.localhost') || value === '::1' || value === '127.0.0.1') return true
  if (isIP(value) === 4) return value.startsWith('127.')
  return false
}

/** Validate data from IPC independently of the UI; never accepts secrets or arbitrary headers. */
export function normalizeTargetApiScope(input: unknown): NormalizedTargetApiScope {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Target API scope must be an object.')
  const raw = input as Record<string, unknown>
  if (raw.authorizationConfirmed !== true) throw new Error('Explicit authorization confirmation is required before target API investigation.')
  if (typeof raw.baseUrl !== 'string' || raw.baseUrl.length > 2048) throw new Error('Target API base URL is invalid.')
  let url: URL
  try { url = new URL(raw.baseUrl.trim()) } catch { throw new Error('Target API base URL must be absolute HTTP(S).') }
  if (url.username || url.password || url.search || url.hash) throw new Error('Target API base URL cannot contain user information, query parameters or fragments.')
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Target API supports HTTP(S) only.')
  if (url.pathname.split('/').some(segment => segment === '.' || segment === '..')) throw new Error('Target API base path cannot contain dot-segment traversal.')
  const kind = loopbackHost(url.hostname) ? 'local' : 'cloud'
  // Reuse the same strict endpoint checks as model-provider traffic: loopback HTTP only; public HTTPS only.
  const validatedBase = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
  // The URL policy is independently repeated here to avoid trusting renderer-supplied classification.
  if (kind === 'local') {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Loopback targets must use HTTP(S).')
  } else if (url.protocol !== 'https:') {
    throw new Error('Non-loopback target API hosts must use HTTPS.')
  }

  if (!Array.isArray(raw.paths) || raw.paths.length > MAX_PATHS) throw new Error(`Provide at most ${MAX_PATHS} explicit relative GET paths.`)
  const normalizedPaths: string[] = []
  for (const item of raw.paths) {
    if (typeof item !== 'string' || item.length > 200) throw new Error('Each target API path must be a string of at most 200 characters.')
    const value = item.trim().replace(/^\/+/, '')
    if (!value) continue
    if (value.includes('\\') || /[%?#\u0000-\u001f\u007f]/.test(value) || value.startsWith('//')) {
      throw new Error('API paths cannot contain backslashes, percent-encoding, query/fragment syntax or control characters.')
    }
    const segments = value.split('/')
    if (segments.some(segment => !segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9._~-]+$/.test(segment))) {
      throw new Error('API paths must be normalized relative paths made of letters, digits, dots, underscores, tildes and hyphens.')
    }
    if (!normalizedPaths.includes(value)) normalizedPaths.push(value)
  }
  if (normalizedPaths.length === 0) normalizedPaths.push('')
  if (!isAbsoluteHttpBase(validatedBase)) throw new Error('Target API base URL is not valid.')
  return { baseUrl: validatedBase, paths: normalizedPaths, authorizationConfirmed: true }
}

function isAbsoluteHttpBase(value: string): boolean {
  try { const url = new URL(value); return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname) } catch { return false }
}

function endpointUrl(baseUrl: string, path: string): URL {
  const base = new URL(baseUrl)
  const basePath = base.pathname.replace(/\/+$/, '')
  base.pathname = path ? `${basePath}/${path}`.replace(/\/+/g, '/') : (basePath || '/')
  base.search = ''
  base.hash = ''
  return base
}

function inspectOpenApi(contentType: string | null, body: string): { version: string | null; count: number; samples: string[] } {
  if (!contentType?.toLowerCase().includes('json')) return { version: null, count: 0, samples: [] }
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const version = typeof parsed.openapi === 'string' ? parsed.openapi : typeof parsed.swagger === 'string' ? parsed.swagger : null
    const paths = parsed.paths && typeof parsed.paths === 'object' && !Array.isArray(parsed.paths) ? Object.keys(parsed.paths as Record<string, unknown>) : []
    return { version, count: paths.length, samples: paths.slice(0, 40).map(path => path.slice(0, 300)) }
  } catch { return { version: null, count: 0, samples: [] } }
}

/** Performs only the exact GETs supplied by the operator. No auth, redirects, crawling, writes or mutation verbs. */
export async function investigateTargetApi(input: unknown, options: TargetApiOptions = {}): Promise<TargetApiInvestigationResult> {
  const scope = normalizeTargetApiScope(input)
  const url = new URL(scope.baseUrl)
  const kind = loopbackHost(url.hostname) ? 'local' : 'cloud'
  const resolved = await resolveProviderEndpoint({ name: 'Authorized target API', kind, baseUrl: scope.baseUrl, model: 'read-only-target-inspection' }, options.resolveHost)
  if (!resolved.result) throw new Error(`Target API network policy denied the request: ${resolved.error ?? 'safe resolution failed'}`)

  const endpoints: TargetApiEndpointResult[] = []
  for (const path of scope.paths) {
    if (options.signal?.aborted) throw new Error('Target API investigation cancelled before the next request.')
    const endpoint = endpointUrl(scope.baseUrl, path)
    if (endpoint.origin !== url.origin) throw new Error('Target API path escaped the explicitly authorized origin.')
    const started = performance.now()
    await options.onBeforeRequest?.(path, endpoint.toString())
    let response: ProviderHttpResponse
    try {
      response = await (options.requestImpl ?? requestPinnedHttp)(endpoint, {
        Accept: 'application/json, application/yaml, text/yaml, text/plain;q=0.8, */*;q=0.1',
        'User-Agent': 'RSL-Workbench-Target-API/0.2',
        'Cache-Control': 'no-cache'
      }, Math.min(Math.max(options.timeoutMs ?? REQUEST_TIMEOUT_MS, 250), 15_000), resolved.result.address, {
        method: 'GET', maxResponseBytes: MAX_RESPONSE_BYTES, signal: options.signal
      })
    } catch (error) {
      const message = redactSecrets(error instanceof Error ? error.message : 'Network request failed.').value
      const failed: TargetApiEndpointResult = { path, url: endpoint.toString(), status: null, latencyMs: Math.round(performance.now() - started), contentType: null, responseBytes: 0, sha256: null, ok: false, summary: `Request failed: ${message.slice(0, 300)}`, responsePreview: '', safeBody: '', bodyTruncated: false, openApiVersion: null, discoveredPathCount: 0, discoveredPathSamples: [] }
      endpoints.push(failed)
      await options.onEndpointResult?.(failed, endpoints.length, scope.paths.length)
      // Transport errors can happen after the server received the request. Stop here and require reconciliation.
      await options.onAfterRequest?.(path, 'possible', `GET ${endpoint.toString()} ended without an HTTP response; the remote outcome is uncertain.`)
      break
    }

    const elapsed = Math.round(performance.now() - started)
    const contentType = response.headers?.['content-type']?.slice(0, 200) ?? null
    const redacted = redactSecrets(response.body)
    const safeBody = redacted.value
    const safeBytes = Buffer.byteLength(safeBody, 'utf8')
    const persisted = Buffer.from(safeBody, 'utf8').subarray(0, MAX_PERSISTED_BODY_BYTES).toString('utf8')
    const parsedOpenApi = inspectOpenApi(contentType, safeBody)
    const statusOk = response.status >= 200 && response.status < 300
    const redirect = response.status >= 300 && response.status < 400
    const endpointResult: TargetApiEndpointResult = {
      path, url: endpoint.toString(), status: response.status, latencyMs: elapsed, contentType,
      responseBytes: Buffer.byteLength(response.body, 'utf8'),
      sha256: createHash('sha256').update(safeBody, 'utf8').digest('hex'),
      ok: statusOk,
      summary: redirect ? `HTTP ${response.status}; redirect was not followed.` : statusOk ? `HTTP ${response.status}; redacted response captured locally.` : `HTTP ${response.status}; response body retained only as redacted evidence.`,
      responsePreview: persisted.slice(0, 8000), safeBody: persisted,
      bodyTruncated: safeBytes > MAX_PERSISTED_BODY_BYTES,
      openApiVersion: parsedOpenApi.version, discoveredPathCount: parsedOpenApi.count,
      discoveredPathSamples: parsedOpenApi.samples
    }
    endpoints.push(endpointResult)
    // Evidence persistence must finish before the checkpoint marks this request complete.
    await options.onEndpointResult?.(endpointResult, endpoints.length, scope.paths.length)
    await options.onAfterRequest?.(path, 'known_complete', `Received HTTP ${response.status} for ${endpoint.toString()}; redacted response artifact persisted.`)
  }
  const successfulCount = endpoints.filter(endpoint => endpoint.ok).length
  return {
    schemaVersion: '1.0', observedAtUtc: (options.now?.() ?? new Date()).toISOString(), baseUrl: scope.baseUrl,
    method: 'GET', authHeadersSent: false, redirectPolicy: 'do_not_follow', requestCount: endpoints.length, successfulCount, endpoints,
    limitations: [
      'Only operator-listed paths were requested; discovered OpenAPI paths are evidence only and are not crawled automatically.',
      'Only unauthenticated GET requests are implemented. No cookies, Authorization header, writes, fuzzing or mutation verbs are sent.',
      'Redirects are not followed. A remote target must use HTTPS and resolve only to public addresses; loopback HTTP is allowed for local development.',
      'Response bodies are heuristically secret-redacted before persistence; redaction is not guaranteed to detect every secret or personal datum.',
      'This flow does not prove authorization, endpoint reachability beyond the observed responses, or API behavior outside the explicit request list.'
    ]
  }
}

export const TARGET_API_LIMITS = { maxPaths: MAX_PATHS, maxResponseBytes: MAX_RESPONSE_BYTES, maxPersistedBodyBytes: MAX_PERSISTED_BODY_BYTES, timeoutMs: REQUEST_TIMEOUT_MS }
