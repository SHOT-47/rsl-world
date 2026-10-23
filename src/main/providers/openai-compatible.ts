import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { redactSecrets } from '../redaction.ts'

export type ProviderKind = 'local' | 'cloud'
export interface ProviderEndpointInput { name: string; kind: ProviderKind; baseUrl: string; model: string }
export interface ProviderModel { id: string; ownedBy?: string }
export interface ProviderTestResult {
  ok: boolean; endpoint: string; latencyMs: number; status: number | null; models: ProviderModel[];
  selectedModelAvailable: boolean | null; summary: string; details: string[]
}
export type HostResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>
export interface ProviderHttpResponse { status: number; body: string; headers?: Record<string, string> }
export type ProviderRequest = (url: URL, headers: Record<string, string>, timeoutMs: number, pinnedAddress: { address: string; family: number }, options?: { method?: string; body?: string; maxResponseBytes?: number; signal?: AbortSignal }) => Promise<ProviderHttpResponse>
export interface ResolvedProviderEndpoint { endpointBase: string; address: { address: string; family: number } }

const MAX_RESPONSE_BYTES = 1_000_000
const REQUEST_TIMEOUT_MS = 12_000

function normalizedHost(host: string): string { return host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '') }
function isLoopbackHost(host: string): boolean {
  const value = normalizedHost(host)
  return value === 'localhost' || value.endsWith('.localhost') || value === '::1' || value === '127.0.0.1' || /^127\./.test(value)
}
function isLoopbackAddress(address: string): boolean {
  const value = normalizedHost(address)
  return value === '::1' || value === '127.0.0.1' || /^127\./.test(value)
}
function isPrivateOrSpecialIPv4(address: string): boolean {
  const octets = address.split('.').map(Number)
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return true
  const [a, b] = octets
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 88 || b === 168)) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0)
}
function isPrivateOrSpecialIPv6(address: string): boolean {
  const value = normalizedHost(address).split('%')[0]
  if (value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb') || value.startsWith('ff')) return true
  if (value.startsWith('::ffff:')) {
    const mapped = value.slice('::ffff:'.length)
    if (isIP(mapped) === 4) return isPrivateOrSpecialIPv4(mapped)
  }
  const firstHex = Number.parseInt(value.split(':')[0] || '0', 16)
  // Permit only global-unicast 2000::/3 and reject documentation/transition/special ranges conservatively.
  if (!Number.isFinite(firstHex) || firstHex < 0x2000 || firstHex > 0x3fff) return true
  return value.startsWith('2001:db8:') || value.startsWith('2001:0:') || value.startsWith('2002:') || value.startsWith('2001:20:')
}
function isPublicAddress(address: string, family: number): boolean {
  if (family === 4 || isIP(address) === 4) return !isPrivateOrSpecialIPv4(address)
  if (family === 6 || isIP(address) === 6) return !isPrivateOrSpecialIPv6(address)
  return false
}

export function validateProviderEndpoint(input: ProviderEndpointInput): { normalizedBaseUrl: string; error: string | null } {
  if (!input || typeof input !== 'object') return { normalizedBaseUrl: '', error: 'Provider configuration is required.' }
  if (typeof input.name !== 'string' || input.name.trim().length < 1 || input.name.trim().length > 100) return { normalizedBaseUrl: '', error: 'Provider name must contain 1–100 characters.' }
  if (input.kind !== 'local' && input.kind !== 'cloud') return { normalizedBaseUrl: '', error: 'Provider kind must be local or cloud.' }
  if (typeof input.model !== 'string' || !input.model.trim() || input.model.trim().length > 200) return { normalizedBaseUrl: '', error: 'Model name must contain 1–200 characters.' }
  if (typeof input.baseUrl !== 'string' || input.baseUrl.length > 2048) return { normalizedBaseUrl: '', error: 'Provider base URL is invalid.' }

  let url: URL
  try { url = new URL(input.baseUrl.trim()) } catch { return { normalizedBaseUrl: '', error: 'Enter an absolute HTTP(S) base URL.' } }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { normalizedBaseUrl: '', error: 'Only HTTP or HTTPS provider endpoints are supported.' }
  if (url.username || url.password || url.search || url.hash) return { normalizedBaseUrl: '', error: 'Provider URLs cannot contain credentials, query parameters or fragments.' }
  if (url.pathname.split('/').some(segment => segment === '.' || segment === '..')) return { normalizedBaseUrl: '', error: 'Provider URL cannot contain dot-segment path traversal.' }

  const hostname = normalizedHost(url.hostname)
  if (input.kind === 'local') {
    if (!isLoopbackHost(hostname)) return { normalizedBaseUrl: '', error: 'Local-model endpoints must bind to loopback (localhost, 127.0.0.1 or ::1); LAN endpoints are denied by default.' }
  } else {
    if (url.protocol !== 'https:') return { normalizedBaseUrl: '', error: 'Cloud provider endpoints must use HTTPS.' }
    if (isLoopbackHost(hostname) || (isIP(hostname) === 4 && isPrivateOrSpecialIPv4(hostname)) || (isIP(hostname) === 6 && isPrivateOrSpecialIPv6(hostname))) {
      return { normalizedBaseUrl: '', error: 'Cloud provider endpoints cannot target a loopback, private or special-use IP address.' }
    }
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  return { normalizedBaseUrl: url.toString().replace(/\/$/, ''), error: null }
}

async function defaultResolveHost(hostname: string): Promise<Array<{ address: string; family: number }>> {
  if (isIP(normalizedHost(hostname))) return [{ address: normalizedHost(hostname), family: isIP(normalizedHost(hostname)) }]
  return lookup(hostname, { all: true, verbatim: true })
}

export function requestPinnedHttp(url: URL, headers: Record<string, string>, timeoutMs: number, pinnedAddress: { address: string; family: number }, options: { method?: string; body?: string; maxResponseBytes?: number; signal?: AbortSignal } = {}): Promise<ProviderHttpResponse> {
  return new Promise((resolve, reject) => {
    const sender = url.protocol === 'https:' ? httpsRequest : httpRequest
    let received = 0
    const chunks: Buffer[] = []
    let settled = false
    const finishError = (error: Error) => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', onAbort)
      reject(error)
    }
    const onAbort = () => request.destroy(new Error('Provider request cancelled.'))
    const maxBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES
    const requestHeaders = { ...headers }
    if (options.body !== undefined && !('Content-Length' in requestHeaders) && !('content-length' in requestHeaders)) requestHeaders['Content-Length'] = String(Buffer.byteLength(options.body, 'utf8'))
    const request = sender(url, {
      method: options.method ?? 'GET', headers: requestHeaders, agent: undefined, rejectUnauthorized: true,
      lookup: ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
        if (options?.all) callback(null, [{ address: pinnedAddress.address, family: pinnedAddress.family }])
        else callback(null, pinnedAddress.address, pinnedAddress.family)
      }) as never
    }, response => {
      const declaredLength = Number(response.headers['content-length'] ?? 0)
      if (declaredLength > maxBytes) {
        response.destroy(new Error(`Provider response exceeds the ${Math.floor(maxBytes / 1_000_000)} MB response limit.`))
        request.destroy(new Error(`Provider response exceeds the ${Math.floor(maxBytes / 1_000_000)} MB response limit.`))
        return
      }
      response.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        received += buffer.length
        if (received > maxBytes) {
          response.destroy(new Error(`Provider response exceeds the ${Math.floor(maxBytes / 1_000_000)} MB response limit.`))
          request.destroy(new Error(`Provider response exceeds the ${Math.floor(maxBytes / 1_000_000)} MB response limit.`))
          return
        }
        chunks.push(buffer)
      })
      response.on('error', finishError)
      response.on('end', () => {
        if (settled) return
        settled = true
        options.signal?.removeEventListener('abort', onAbort)
        const safeHeaders: Record<string, string> = {}
        for (const key of ['content-type', 'content-length', 'etag', 'last-modified', 'cache-control', 'allow']) { const value = response.headers[key]; if (typeof value === 'string') safeHeaders[key] = value.slice(0, 500) }
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: safeHeaders })
      })
    })
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Provider diagnostic timed out.')))
    if (options.signal?.aborted) { request.destroy(new Error('Provider request cancelled.')); return }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    request.on('error', finishError)
    request.end(options.body)
  })
}

export async function resolveProviderEndpoint(input: ProviderEndpointInput, resolver: HostResolver = defaultResolveHost): Promise<{ result: ResolvedProviderEndpoint | null; error: string | null }> {
  const validated = validateProviderEndpoint(input)
  if (validated.error) return { result: null, error: validated.error }
  const base = new URL(validated.normalizedBaseUrl)
  let addresses: Array<{ address: string; family: number }>
  try {
    addresses = await resolver(base.hostname)
    if (!addresses.length) throw new Error('No DNS addresses returned.')
    if (input.kind === 'local') {
      if (addresses.some(entry => !isLoopbackAddress(entry.address))) throw new Error('Local hostname resolved to a non-loopback address.')
    } else if (addresses.some(entry => !isPublicAddress(entry.address, entry.family))) {
      return { result: null, error: 'The configured cloud hostname resolved to a private or special-use address. No request was sent.' }
    }
  } catch { return { result: null, error: 'Provider hostname could not be safely resolved. Check DNS and endpoint policy. No request was sent.' } }
  const address = addresses[0]
  if (!address) return { result: null, error: 'No usable provider network address was returned.' }
  return { result: { endpointBase: validated.normalizedBaseUrl, address }, error: null }
}

export async function testOpenAiCompatibleProvider(
  input: ProviderEndpointInput,
  apiKey: string | null,
  options: { requestImpl?: ProviderRequest; resolveHost?: HostResolver; timeoutMs?: number } = {}
): Promise<ProviderTestResult> {
  const started = performance.now()
  const validated = validateProviderEndpoint(input)
  if (validated.error) return { ok: false, endpoint: input?.baseUrl ?? '', latencyMs: 0, status: null, models: [], selectedModelAvailable: null, summary: 'Provider configuration rejected.', details: [validated.error] }

  const resolved = await resolveProviderEndpoint(input, options.resolveHost ?? defaultResolveHost)
  if (!resolved.result) {
    const blocked = /private or special-use address/i.test(resolved.error ?? '')
    return { ok: false, endpoint: validated.normalizedBaseUrl, latencyMs: Math.round(performance.now() - started), status: null, models: [], selectedModelAvailable: null, summary: blocked ? 'Provider endpoint blocked by network policy.' : 'Provider hostname could not be safely resolved.', details: [resolved.error ?? 'No request was sent.'] }
  }
  const address = resolved.result.address
  const endpoint = new URL(`${validated.normalizedBaseUrl.replace(/\/+$/, '')}/models`)
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'RSL-Workbench-Provider-Diagnostics/0.1' }
  if (apiKey?.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`

  try {
    // Pin the HTTP connection to the already-vetted DNS address to limit rebinding/TOCTOU risk.
    const response = await (options.requestImpl ?? requestPinnedHttp)(endpoint, headers, options.timeoutMs ?? REQUEST_TIMEOUT_MS, address, { method: 'GET', maxResponseBytes: MAX_RESPONSE_BYTES })
    if (response.body.length > MAX_RESPONSE_BYTES) throw new Error(`Provider response exceeds the ${Math.floor(MAX_RESPONSE_BYTES / 1_000_000)} MB diagnostic limit.`)
    if (response.status < 200 || response.status >= 300) {
      const hint = response.status === 401 || response.status === 403 ? 'Authentication was rejected; verify the credential and provider permissions.' :
        response.status === 404 ? 'The endpoint did not expose an OpenAI-compatible /models route; check the base URL and adapter type.' :
          response.status >= 500 ? 'The provider returned a server error.' : response.status >= 300 ? 'Redirects are not followed; configure the final endpoint directly.' : 'The provider rejected the diagnostic request.'
      return { ok: false, endpoint: validated.normalizedBaseUrl, latencyMs: Math.round(performance.now() - started), status: response.status, models: [], selectedModelAvailable: null, summary: 'Provider connection test failed.', details: [`HTTP ${response.status}. ${hint}`] }
    }
    let payload: unknown
    try { payload = JSON.parse(response.body) } catch { throw new Error('Provider returned a response that was not valid JSON.') }
    if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { data?: unknown }).data)) throw new Error('Provider response did not match the OpenAI-compatible model-list contract (expected data[]).')
    const rows = (payload as { data: unknown[] }).data
    const models: ProviderModel[] = rows.slice(0, 200).flatMap(row => {
      if (!row || typeof row !== 'object' || typeof (row as { id?: unknown }).id !== 'string') return []
      const model: ProviderModel = { id: (row as { id: string }).id.slice(0, 200) }
      if (typeof (row as { owned_by?: unknown }).owned_by === 'string') model.ownedBy = (row as { owned_by: string }).owned_by.slice(0, 100)
      return [model]
    })
    const selectedModelAvailable = models.some(model => model.id === input.model.trim())
    return {
      ok: true, endpoint: validated.normalizedBaseUrl, latencyMs: Math.round(performance.now() - started), status: response.status, models,
      selectedModelAvailable, summary: 'Provider endpoint responded with a valid model list.',
      details: [models.length ? `${models.length} model identifier(s) discovered${rows.length > 200 ? '; display capped at 200.' : '.'}` : 'Connection succeeded, but the provider returned no valid model identifiers.',
        selectedModelAvailable ? 'Configured model appears in the provider model list.' : 'Configured model was not found in the returned list; this may be valid for providers that do not expose all models.']
    }
  } catch (error) {
    let reason = error instanceof Error ? error.message : 'Unknown network error.'
    reason = redactSecrets(reason).value.slice(0, 500)
    if (/socket hang up|connect econnrefused|network|ehostunreach|enotfound|etimedout/i.test(reason)) reason = 'Network connection failed or timed out. Check endpoint reachability and local network policy.'
    if (/self-signed certificate|certificate|tls/i.test(reason)) reason = 'TLS validation failed. The provider certificate must validate; insecure certificate bypass is disabled.'
    return { ok: false, endpoint: validated.normalizedBaseUrl, latencyMs: Math.round(performance.now() - started), status: null, models: [], selectedModelAvailable: null, summary: 'Provider connection test failed.', details: [reason] }
  }
}
