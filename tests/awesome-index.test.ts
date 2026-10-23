import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchAwesomeReverseEngineeredPriorArt, buildPriorArtQuery } from '../src/main/workflows/rsl-investigation.ts'

const INDEX_URL = 'https://awesome.alexgaoth.com/data.json'
const INDEX = {
  meta: { n: 4, updated: '2026-10-21', cats: [] },
  rows: [
    ['tuya-local', 'https://github.com/make-all/tuya-local', 'Local control for Tuya devices', 'Devices, IoT & Hardware', 'Smart Home', 1400, 'Python', 'MIT', '2026-10-10', 'active', ['tuya', 'local-control'], ''],
    ['tuya-cli', 'https://github.com/example/tuya-cli', 'Command line tools for Tuya devices', 'Devices, IoT & Hardware', 'Smart Home', 40, 'TypeScript', 'Apache-2.0', '2026-03-03', 'active', ['tuya'], ''],
    ['unrelated', 'https://github.com/example/other', 'Unrelated parser', 'File Formats', 'Documents', 99999, 'Rust', 'MIT', '2026-09-01', 'active', ['parser'], ''],
    ['unsafe-link', 'http://attacker.invalid/tuya', 'Tuya credentials helper', 'Messaging', 'Utilities', 1, 'Python', 'MIT', '2026-10-01', 'active', ['tuya'], '']
  ]
}
const publicResolveHost = async (hostname: string) => {
  assert.equal(hostname, 'awesome.alexgaoth.com')
  return [{ address: '8.8.8.8', family: 4 }]
}

test('target name query is locally derived, secret-like terms are removed, and no query is sent to index host', async () => {
  assert.equal(buildPriorArtQuery('Investigate Tuya local api_key=supersecret123456'), 'Tuya local')
  const temp = await mkdtemp(join(tmpdir(), 'rsl-awesome-index-'))
  let calls = 0
  let requestedUrl = ''
  try {
    const result = await searchAwesomeReverseEngineeredPriorArt('Tuya local', {
      cachePath: join(temp, 'index.json'), resolveHost: publicResolveHost, now: () => new Date('2026-10-22T10:00:00.000Z'),
      requestImpl: async (url, headers, timeout, address, requestOptions) => {
        calls++
        requestedUrl = url.toString()
        assert.equal(url.toString(), INDEX_URL)
        assert.equal(url.search, '')
        assert.equal(headers.Accept, 'application/json')
        assert.equal(timeout, 15_000)
        assert.equal(address.address, '8.8.8.8')
        assert.equal(requestOptions?.method, 'GET')
        assert.equal(requestOptions?.maxResponseBytes, 12 * 1024 * 1024)
        return { status: 200, body: JSON.stringify(INDEX), headers: { etag: '"v1"', 'last-modified': 'Wed, 21 Oct 2026 00:00:00 GMT' } }
      }
    })
    assert.equal(calls, 1)
    assert.equal(requestedUrl, INDEX_URL)
    assert.equal(result.status, 'completed')
    assert.equal(result.source, INDEX_URL)
    assert.equal(result.indexUpdatedAt, '2026-10-21')
    assert.equal(result.results.length, 2)
    assert.equal(result.results[0]?.fullName, 'tuya-local')
    assert.deepEqual(result.results[0]?.matchedTerms, ['tuya', 'local'])
    assert.equal(result.results[0]?.fitAssessment, 'not_assessed')
    assert.equal(result.results.some(candidate => candidate.fullName === 'unsafe-link'), false)
    assert.equal(result.limitations.some(item => /query and project files are not sent/i.test(item)), true)
    const cached = JSON.parse(await readFile(join(temp, 'index.json'), 'utf8'))
    assert.equal(cached.version, 1)
    assert.equal(cached.etag, '"v1"')
    assert.equal(typeof cached.payloadSha256, 'string')
  } finally { await rm(temp, { recursive: true, force: true }) }
})

test('fresh verified local index cache avoids network and retains cache-age provenance', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rsl-awesome-cache-'))
  const cachePath = join(temp, 'index.json')
  let calls = 0
  const now = new Date('2026-10-22T10:00:00.000Z')
  try {
    const first = await searchAwesomeReverseEngineeredPriorArt('Tuya', {
      cachePath, resolveHost: publicResolveHost, now: () => now,
      requestImpl: async () => { calls++; return { status: 200, body: JSON.stringify(INDEX), headers: { etag: '"cached"' } } }
    })
    const second = await searchAwesomeReverseEngineeredPriorArt('Tuya', {
      cachePath, resolveHost: async () => { throw new Error('fresh cache must avoid DNS') }, now: () => new Date(now.getTime() + 60 * 60 * 1000),
      requestImpl: async () => { calls++; throw new Error('fresh cache must avoid network') }
    })
    assert.equal(first.status, 'completed')
    assert.equal(second.status, 'completed')
    assert.equal(calls, 1)
    assert.ok((second.cacheAgeHours ?? 0) >= 0.99 && (second.cacheAgeHours ?? 0) <= 1.01)
  } finally { await rm(temp, { recursive: true, force: true }) }
})

test('stale or tampered index cache does not get treated as fresh; bad response is not cached', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rsl-awesome-invalid-'))
  const cachePath = join(temp, 'index.json')
  let calls = 0
  const now = new Date('2026-10-23T10:00:00.000Z')
  try {
    const first = await searchAwesomeReverseEngineeredPriorArt('Tuya', {
      cachePath, resolveHost: publicResolveHost, now: () => now,
      requestImpl: async () => { calls++; return { status: 200, body: '{invalid-json', headers: {} } }
    })
    assert.equal(first.status, 'unavailable')
    assert.match(first.error ?? '', /invalid JSON/i)
    await assert.rejects(() => readFile(cachePath, 'utf8'), /ENOENT/)
  } finally { await rm(temp, { recursive: true, force: true }) }
})

test('expired valid cache gets refreshed and a failed index response is represented as unavailable', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rsl-awesome-stale-'))
  const cachePath = join(temp, 'index.json')
  let calls = 0
  const t0 = new Date('2026-10-20T00:00:00.000Z')
  try {
    await searchAwesomeReverseEngineeredPriorArt('Tuya', { cachePath, resolveHost: publicResolveHost, now: () => t0,
      requestImpl: async () => { calls++; return { status: 200, body: JSON.stringify(INDEX), headers: {} } } })
    const failed = await searchAwesomeReverseEngineeredPriorArt('Tuya', { cachePath, resolveHost: publicResolveHost, now: () => new Date('2026-10-22T00:00:00.000Z'),
      requestImpl: async () => { calls++; return { status: 503, body: 'temporarily unavailable', headers: {} } } })
    assert.equal(calls, 2)
    assert.equal(failed.status, 'unavailable')
    assert.match(failed.error ?? '', /HTTP 503/)
  } finally { await rm(temp, { recursive: true, force: true }) }
})


test('stale cache sends conditional validators and accepts a 304 only with verified cached content', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rsl-awesome-etag-'))
  const cachePath = join(temp, 'index.json')
  let calls = 0
  try {
    await searchAwesomeReverseEngineeredPriorArt('Tuya', { cachePath, resolveHost: publicResolveHost, now: () => new Date('2026-10-20T00:00:00.000Z'),
      requestImpl: async () => { calls++; return { status: 200, body: JSON.stringify(INDEX), headers: { etag: '"stable-v1"', 'last-modified': 'Wed, 21 Oct 2026 00:00:00 GMT' } } } })
    const refreshed = await searchAwesomeReverseEngineeredPriorArt('Tuya', { cachePath, resolveHost: publicResolveHost, now: () => new Date('2026-10-22T00:00:00.000Z'),
      requestImpl: async (_url, headers) => {
        calls++
        assert.equal(headers['If-None-Match'], '"stable-v1"')
        assert.equal(headers['If-Modified-Since'], 'Wed, 21 Oct 2026 00:00:00 GMT')
        return { status: 304, body: '', headers: { etag: '"stable-v1"' } }
      } })
    assert.equal(calls, 2)
    assert.equal(refreshed.status, 'completed')
    assert.equal(refreshed.cacheAgeHours, 0)
    assert.equal(refreshed.results[0]?.fullName, 'tuya-local')
  } finally { await rm(temp, { recursive: true, force: true }) }
})


test('modified cache payload with mismatched checksum is never trusted', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rsl-awesome-tamper-'))
  const cachePath = join(temp, 'index.json')
  let calls = 0
  try {
    await searchAwesomeReverseEngineeredPriorArt('Tuya', { cachePath, resolveHost: publicResolveHost, now: () => new Date('2026-10-22T00:00:00.000Z'),
      requestImpl: async () => { calls++; return { status: 200, body: JSON.stringify(INDEX), headers: {} } } })
    const cached = JSON.parse(await readFile(cachePath, 'utf8'))
    cached.payloadJson = JSON.stringify({ meta: { n: 0, updated: '2026-10-22', cats: [] }, rows: [] })
    await (await import('node:fs/promises')).writeFile(cachePath, JSON.stringify(cached))
    const refreshed = await searchAwesomeReverseEngineeredPriorArt('Tuya', { cachePath, resolveHost: publicResolveHost, now: () => new Date('2026-10-22T00:01:00.000Z'),
      requestImpl: async () => { calls++; return { status: 200, body: JSON.stringify(INDEX), headers: {} } } })
    assert.equal(calls, 2)
    assert.equal(refreshed.status, 'completed')
    assert.equal(refreshed.results[0]?.fullName, 'tuya-local')
  } finally { await rm(temp, { recursive: true, force: true }) }
})
