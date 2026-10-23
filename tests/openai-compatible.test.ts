import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { testOpenAiCompatibleProvider, validateProviderEndpoint } from '../src/main/providers/openai-compatible.ts'

async function withServer(handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void, work: (baseUrl: string) => Promise<void>): Promise<void> {
  const server: Server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port.')
  try { await work(`http://127.0.0.1:${address.port}/v1`) }
  finally { await new Promise<void>(resolve => server.close(() => resolve())) }
}

test('local endpoints must bind to loopback; LAN targets are denied by default', () => {
  assert.equal(validateProviderEndpoint({ name: 'local', kind: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen' }).error, null)
  assert.match(validateProviderEndpoint({ name: 'local', kind: 'local', baseUrl: 'http://192.168.1.5:11434/v1', model: 'qwen' }).error ?? '', /loopback/i)
  assert.match(validateProviderEndpoint({ name: 'local', kind: 'local', baseUrl: 'http://attacker.example:11434/v1', model: 'qwen' }).error ?? '', /loopback/i)
})

test('cloud endpoints must use HTTPS and cannot use private or loopback IP literals', () => {
  assert.match(validateProviderEndpoint({ name: 'cloud', kind: 'cloud', baseUrl: 'http://api.example.com/v1', model: 'm' }).error ?? '', /HTTPS/)
  assert.match(validateProviderEndpoint({ name: 'cloud', kind: 'cloud', baseUrl: 'https://127.0.0.1/v1', model: 'm' }).error ?? '', /private|loopback/i)
  assert.match(validateProviderEndpoint({ name: 'cloud', kind: 'cloud', baseUrl: 'https://192.88.99.1/v1', model: 'm' }).error ?? '', /private|special-use/i)
  assert.match(validateProviderEndpoint({ name: 'cloud', kind: 'cloud', baseUrl: 'https://10.1.2.3/v1', model: 'm' }).error ?? '', /private|loopback/i)
  assert.match(validateProviderEndpoint({ name: 'cloud', kind: 'cloud', baseUrl: 'https://u:p@api.example.com/v1', model: 'm' }).error ?? '', /credentials/)
})

test('diagnostics discovers models through /models and sends a configured bearer key without exposing it', async () => {
  let authorization = ''
  await withServer((req, res) => {
    authorization = String(req.headers.authorization ?? '')
    assert.equal(req.url, '/v1/models')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'qwen3', owned_by: 'local' }, { id: 'coder' }] }))
  }, async baseUrl => {
    const result = await testOpenAiCompatibleProvider({ name: 'local', kind: 'local', baseUrl, model: 'qwen3' }, 'test-secret-not-for-logs')
    assert.equal(result.ok, true)
    assert.equal(result.selectedModelAvailable, true)
    assert.equal(result.models.length, 2)
    assert.match(authorization, /^Bearer test-secret/)
    assert.equal(JSON.stringify(result).includes('test-secret-not-for-logs'), false)
  })
})

test('HTTP errors return safe diagnostics without echoing response body or credentials', async () => {
  await withServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end('{"error":"bad key: test-secret-not-for-logs"}')
  }, async baseUrl => {
    const result = await testOpenAiCompatibleProvider({ name: 'local', kind: 'local', baseUrl, model: 'model' }, 'test-secret-not-for-logs')
    assert.equal(result.ok, false)
    assert.equal(result.status, 401)
    assert.match(result.details[0], /Authentication was rejected/)
    assert.equal(JSON.stringify(result).includes('test-secret-not-for-logs'), false)
  })
})

test('remote cloud host resolving to a private address is blocked before fetch', async () => {
  let fetched = false
  const result = await testOpenAiCompatibleProvider({ name: 'remote', kind: 'cloud', baseUrl: 'https://provider.example/v1', model: 'model' }, null, {
    resolveHost: async () => [{ address: '10.0.0.12', family: 4 }],
    requestImpl: async () => { fetched = true; return { status: 200, body: '{"data":[]}' } }
  })
  assert.equal(result.ok, false)
  assert.equal(fetched, false)
  assert.match(result.summary, /blocked by network policy/i)
})

test('redirected provider requests are not followed', async () => {
  let calls = 0
  const result = await testOpenAiCompatibleProvider({ name: 'local', kind: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'model' }, null, {
    requestImpl: async () => {
      calls += 1
      return { status: 302, body: '' }
    }
  })
  assert.equal(calls, 1)
  assert.equal(result.ok, false)
})

test('provider response sizes are bounded', async () => {
  const huge = JSON.stringify({ data: [{ id: 'x' }], padding: 'a'.repeat(1_000_050) })
  const result = await testOpenAiCompatibleProvider({ name: 'local', kind: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'x' }, null, {
    requestImpl: async () => ({ status: 200, body: huge })
  })
  assert.equal(result.ok, false)
  assert.match(result.details[0], /1 MB diagnostic limit/i)
})
