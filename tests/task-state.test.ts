import test from 'node:test'
import assert from 'node:assert/strict'
import { approvalCanBeDecided, assessRecovery, evaluateApproval, isValidTaskTransition, nextCheckpointVersion } from '../src/main/task-state.ts'

const now = Date.parse('2026-10-22T00:00:00Z')

test('clean checkpoint recovers to interrupted/resumable, not replayed', () => {
  const result = assessRecovery(JSON.stringify({ operationInFlight: false, sideEffectState: 'none' }), 'running')
  assert.equal(result.status, 'interrupted')
})

test('in-flight or uncertain side effect recovers to outcome_uncertain', () => {
  assert.equal(assessRecovery(JSON.stringify({ operationInFlight: true }), 'running').status, 'outcome_uncertain')
  assert.equal(assessRecovery(JSON.stringify({ sideEffectState: 'possible' }), 'running').status, 'outcome_uncertain')
  assert.equal(assessRecovery(null, 'running').status, 'outcome_uncertain')
  assert.equal(assessRecovery(null, 'queued').status, 'interrupted')
  assert.equal(assessRecovery('{bad-json', 'running').status, 'outcome_uncertain')
})

test('task transitions prevent silently reviving terminal states', () => {
  assert.equal(isValidTaskTransition('blocked', 'queued'), true)
  assert.equal(isValidTaskTransition('running', 'waiting_approval'), true)
  assert.equal(isValidTaskTransition('succeeded', 'running'), false)
  assert.equal(isValidTaskTransition('outcome_uncertain', 'running'), false)
  assert.equal(isValidTaskTransition('outcome_uncertain', 'cancelled'), true)
})

test('checkpoint version increments monotonically and rejects corrupt prior versions', () => {
  assert.equal(nextCheckpointVersion(0), 1)
  assert.equal(nextCheckpointVersion(8), 9)
  assert.throws(() => nextCheckpointVersion(-1), /Invalid existing checkpoint/)
  assert.throws(() => nextCheckpointVersion(1.5), /Invalid existing checkpoint/)
})

test('approval is one-shot, expiring and bound to exact operation hash', () => {
  const base = { status: 'approved', expiresAt: '2026-10-22T00:05:00Z', storedOperationHash: 'a'.repeat(64), currentOperationHash: 'a'.repeat(64), nowMs: now }
  assert.equal(evaluateApproval(base), 'consume')
  assert.equal(evaluateApproval({ ...base, currentOperationHash: 'b'.repeat(64) }), 'mismatch')
  assert.equal(evaluateApproval({ ...base, expiresAt: '2026-10-21T23:59:00Z' }), 'expired')
  assert.equal(evaluateApproval({ ...base, status: 'pending' }), 'not-approved')
  assert.equal(approvalCanBeDecided('pending', '2026-10-22T00:05:00Z', now), true)
  assert.equal(approvalCanBeDecided('approved', '2026-10-22T00:05:00Z', now), false)
})
