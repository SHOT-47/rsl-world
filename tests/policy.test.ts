import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyOperation, createApprovalPreview, hashOperation, isWithinWorkspace, type ProposedOperation } from '../src/main/policy.ts'
import { redactSecrets, sanitizeJson } from '../src/main/redaction.ts'

function op(overrides: Partial<ProposedOperation> = {}): ProposedOperation {
  return {
    id: 'op-1', kind: 'read_file', summary: 'Read source', target: 'src/index.ts', projectRoot: '/project',
    parameters: { path: '/project/src/index.ts' }, expectedImpact: 'No changes', rollbackInfo: null,
    ...overrides
  }
}

test('read-only operation inside project is allowed', () => {
  assert.equal(classifyOperation(op()).decision, 'allow')
})

test('writes and command execution require exact-action approval', () => {
  assert.equal(classifyOperation(op({ kind: 'write_file' })).decision, 'require_approval')
  assert.equal(classifyOperation(op({ kind: 'execute_command' })).decision, 'require_approval')
})

test('hard-denied operations never become allowed by a host allowlist', () => {
  assert.equal(classifyOperation(op({ kind: 'credential_export' }), new Set(['example.com'])).decision, 'deny')
  assert.equal(classifyOperation(op({ kind: 'policy_override' })).decision, 'deny')
})

test('unapproved destination and sensitive network transfer require approval', () => {
  const request = op({ kind: 'network_request', networkHost: 'api.example.com', httpMethod: 'GET' })
  assert.equal(classifyOperation(request).decision, 'require_approval')
  assert.equal(classifyOperation({ ...request, transfersSensitiveData: true }, new Set(['api.example.com'])).decision, 'require_approval')
  assert.equal(classifyOperation({ ...request, httpMethod: 'POST' }, new Set(['api.example.com'])).decision, 'require_approval')
})

test('path traversal outside selected workspace is denied', () => {
  assert.equal(classifyOperation(op({ parameters: { path: '/outside/secret.txt' } })).decision, 'deny')
  assert.equal(isWithinWorkspace('/project/a/b', '/project'), true)
  assert.equal(isWithinWorkspace('/project-escape/a', '/project'), false)
})

test('approval hash binds to every material operation parameter', () => {
  const first = op({ kind: 'write_file', parameters: { path: '/project/a.ts', content: 'one' } })
  const changed = { ...first, parameters: { path: '/project/a.ts', content: 'two' } }
  assert.notEqual(hashOperation(first), hashOperation(changed))
  assert.equal(createApprovalPreview(first).operationHash, hashOperation(first))
})

test('secret redaction strips provider keys and common key-value secrets', () => {
  assert.match(redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz123').value, /REDACTED/)
  assert.match(redactSecrets('api_key=sk_live_12345678901234567890').value, /REDACTED/)
  const sanitized = JSON.stringify(sanitizeJson({ password: 'hunter2', prompt: 'password=hunter2', nested: ['ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'] }))
  assert.doesNotMatch(sanitized, /hunter2|ABCDEFGHIJKLMNOPQRSTUVWXYZ/)
})

test('normalized workspace-relative write paths require approval rather than being misclassified as escapes', () => {
  const base = { id: 'operation', kind: 'write_file' as const, summary: 'Write file', target: '/workspace/src/app.ts', projectRoot: '/workspace', parameters: { path: 'src/app.ts' }, expectedImpact: 'Replace file' }
  assert.equal(classifyOperation(base).decision, 'require_approval')
  assert.equal(classifyOperation({ ...base, parameters: { path: '../outside.txt' } }).decision, 'deny')
})
