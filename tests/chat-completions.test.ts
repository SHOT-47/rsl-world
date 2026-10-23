import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { requestChatCompletion } from '../src/main/providers/chat-completions.ts'

async function withServer(handler: (request: any, response: any) => void, fn: (url: string) => Promise<void>) {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected test server address.')
  try { await fn(`http://127.0.0.1:${address.port}/v1`) }
  finally { await new Promise<void>(resolve => server.close(() => resolve())) }
}

test('chat adapter sends the selected model and parses tool calls over loopback', async () => {
  await withServer((request, response) => {
    assert.equal(request.url, '/v1/chat/completions')
    assert.equal(request.method, 'POST')
    assert.equal(request.headers.authorization, 'Bearer unit-test-key')
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      const payload = JSON.parse(body)
      assert.equal(payload.model, 'test-model')
      assert.equal(payload.messages[0].role, 'user')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_files', arguments: '{"path":".","recursive":false}' } }] } }], usage: { total_tokens: 19 } }))
    })
  }, async baseUrl => {
    const result = await requestChatCompletion({ id: 'provider-id', name: 'mock', kind: 'local', baseUrl, model: 'test-model', apiKey: 'unit-test-key' }, [{ role: 'user', content: 'List files' }], [{ type: 'function', function: { name: 'list_files', description: 'list', parameters: { type: 'object' } } }])
    assert.equal(result.toolCalls[0]?.function.name, 'list_files')
    assert.equal(result.usage.totalTokens, 19)
  })
})

test('chat adapter does not follow redirects and does not echo provider response secrets', async () => {
  await withServer((_request, response) => {
    response.writeHead(302, { location: 'http://127.0.0.1/redirect-target' })
    response.end('private token response')
  }, async baseUrl => {
    await assert.rejects(() => requestChatCompletion({ id: 'provider-id', name: 'mock', kind: 'local', baseUrl, model: 'test-model', apiKey: null }, [{ role: 'user', content: 'hi' }], []), /HTTP 302/)
  })
})
