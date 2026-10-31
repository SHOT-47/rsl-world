import test from 'node:test'
import assert from 'node:assert/strict'
import {
  auditContext, calculateTokenBudget, createTokenAssistShadowReport, estimatePromptTokensHeuristically,
  getContextHealthSummary, planContextSelection, proposeContextCleanup, reconcileTokenUsage,
  type ContextItem, type ContextBoundaryState, type TokenAssistShadowReport
} from '../src/main/agent/context-intelligence.ts'

const safeBoundary: ContextBoundaryState = {
  checkpointDurable: true, operationInFlight: false, sideEffectState: 'known_complete', pendingApprovalCount: 0
}
const exactCount = (text: string): number => Math.ceil(text.length / 10)
const item = (overrides: Partial<ContextItem> & Pick<ContextItem, 'id' | 'text'>): ContextItem => ({
  kind: 'note', preservation: 'P4', sourceRefs: [], ...overrides
})

test('unknown model capacity remains explicitly unknown and does not alter requests', () => {
  const report = createTokenAssistShadowReport({ requestText: '{"messages":[]}' })
  assert.equal(report.budget.status, 'profile-unknown')
  assert.equal(report.recommendation, 'configure-model-profile')
  assert.equal(report.requestChanged, false)
  assert.equal(report.estimateConfidence, 'low')
})

test('verified model limit and configured cap use the smaller capacity and all reserves', () => {
  const budget = calculateTokenBudget({
    contextWindowTokens: 100_000, configuredContextCapTokens: 80_000,
    maxOutputTokens: 8_000, reasoningReserveTokens: 2_000, toolOverheadTokens: 1_000, uncertaintyMarginTokens: 3_000
  })
  assert.equal(budget.status, 'ready')
  assert.equal(budget.contextLimitTokens, 80_000)
  assert.equal(budget.reservedTokens, 14_000)
  assert.equal(budget.effectiveInputBudgetTokens, 66_000)
})

test('invalid or exhausted model budget fails closed', () => {
  assert.equal(calculateTokenBudget({ contextWindowTokens: -1, maxOutputTokens: 1 }).status, 'invalid-profile')
  assert.equal(calculateTokenBudget({ contextWindowTokens: 100, maxOutputTokens: 100 }).status, 'no-input-budget')
})

test('heuristic token estimate is explicitly low confidence', () => {
  const result = estimatePromptTokensHeuristically('Hello world')
  assert.equal(result.method, 'heuristic-characters-per-token')
  assert.equal(result.confidence, 'low')
  assert.ok(result.tokens > 0)
})

test('usage reconciliation calculates actual-versus-estimated error without retaining prompt text', () => {
  const report = createTokenAssistShadowReport({ requestText: 'secret-free prompt', profile: { contextWindowTokens: 10_000, maxOutputTokens: 1_000 } })
  const observation = reconcileTokenUsage(report, 42)
  assert.equal(observation.actualPromptTokens, 42)
  assert.equal(observation.calibrationEligible, true)
  assert.equal(observation.absoluteErrorTokens, Math.abs(report.estimatedPromptTokens - 42))
  assert.equal(JSON.stringify(report).includes('secret-free prompt'), false)
})

test('context planner always retains P0-P2 and required items before optional material', () => {
  const items = [
    item({ id: 'policy', text: 'policy', preservation: 'P0' }),
    item({ id: 'user', text: 'no network', preservation: 'P1' }),
    item({ id: 'execution', text: 'side-effect is complete', preservation: 'P2' }),
    item({ id: 'required-finding', text: 'verified answer', preservation: 'P3', required: true, sourceRefs: ['evidence:1'], factualClaim: true }),
    item({ id: 'optional', text: 'extra notes', preservation: 'P5', relevance: 0.1 })
  ]
  const plan = planContextSelection({ items, effectiveInputBudgetTokens: 10, countTokens: text => text === 'policy' ? 1 : text === 'no network' ? 2 : text === 'side-effect is complete' ? 3 : text === 'verified answer' ? 2 : 20 })
  assert.equal(plan.status, 'ready')
  assert.deepEqual(plan.selectedItemIds, ['policy', 'user', 'execution', 'required-finding'])
  assert.deepEqual(plan.omittedItemIds, ['optional'])
})

test('planner blocks rather than dropping mandatory context when its budget is too small', () => {
  const items = [item({ id: 'policy', text: 'large policy', preservation: 'P0' })]
  const plan = planContextSelection({ items, effectiveInputBudgetTokens: 1, countTokens: () => 5 })
  assert.equal(plan.status, 'blocked')
  assert.match(plan.blockers.join(' '), /Protected context exceeds/)
})

test('health audit catches unproven factual claims, missing tool pairs and unsafe lifecycle boundaries', () => {
  const items = [
    item({ id: 'finding', text: 'unreferenced fact', preservation: 'P3', factualClaim: true }),
    item({ id: 'call', text: 'run tests', preservation: 'P2', toolRole: 'call', toolCallId: 't1', toolState: 'resolved' })
  ]
  const audit = auditContext({ items, selectedItemIds: ['finding', 'call'], boundary: { ...safeBoundary, operationInFlight: true } })
  assert.equal(audit.passed, false)
  assert.ok(audit.issues.some(issue => /no provenance/.test(issue)))
  assert.ok(audit.issues.some(issue => /no selected matching result/.test(issue)))
  assert.ok(audit.issues.some(issue => /in flight/.test(issue)))
  assert.equal(getContextHealthSummary(audit).status, 'degraded')
})

test('cleanup proposal deduplicates only P4/P5 and preserves source history via archive IDs', () => {
  const items = [
    item({ id: 'policy-a', text: 'never exfiltrate secrets', preservation: 'P0' }),
    item({ id: 'policy-b', text: 'never exfiltrate secrets', preservation: 'P0' }),
    item({ id: 'note-a', text: 'Repeated low-value note', preservation: 'P5' }),
    item({ id: 'note-b', text: 'Repeated low-value note', preservation: 'P5' }),
    item({ id: 'finding', text: 'verified result', preservation: 'P3', required: true, factualClaim: true, sourceRefs: ['case:evidence.json'] })
  ]
  const proposal = proposeContextCleanup({ items, baseVersion: 3, effectiveInputBudgetTokens: 100, countTokens: exactCount, boundary: safeBoundary })
  assert.equal(proposal.status, 'ready')
  assert.deepEqual(proposal.duplicateOf, { 'note-b': 'note-a' })
  assert.ok(proposal.activeItemIds.includes('policy-a') && proposal.activeItemIds.includes('policy-b'))
  assert.ok(proposal.activeItemIds.includes('finding'))
  assert.deepEqual(proposal.archivedItemIds, ['note-b'])
  assert.equal(proposal.committed, false)
})

test('cleanup proposal cannot run across an uncertain side effect or pending approval', () => {
  const items = [item({ id: 'policy', text: 'keep policy', preservation: 'P0' })]
  const proposal = proposeContextCleanup({
    items, baseVersion: 0, effectiveInputBudgetTokens: 100, countTokens: exactCount,
    boundary: { ...safeBoundary, sideEffectState: 'possible', pendingApprovalCount: 1 }
  })
  assert.equal(proposal.status, 'unsafe-boundary')
  assert.equal(proposal.candidateHash, null)
  assert.equal(proposal.archivedItemIds.length, 0)
})

test('cleanup proposal keeps previous state if a factual summary has lost provenance', () => {
  const items = [item({ id: 'fact', text: 'claim without evidence', preservation: 'P3', required: true, factualClaim: true })]
  const proposal = proposeContextCleanup({ items, baseVersion: 1, effectiveInputBudgetTokens: 100, countTokens: exactCount, boundary: safeBoundary })
  assert.equal(proposal.status, 'blocked')
  assert.equal(proposal.candidateHash, null)
  assert.deepEqual(proposal.activeItemIds, ['fact'])
  assert.equal(proposal.archivedItemIds.length, 0)
})

test('health audit does not allow a stale snapshot to archive mandatory records', () => {
  const protectedItem = item({
    id: 'archived-user-requirement', text: 'Never access the network.', preservation: 'P1',
    required: true, active: false
  })
  const audit = auditContext({ items: [protectedItem], selectedItemIds: [], boundary: safeBoundary })
  assert.equal(audit.passed, false)
  assert.ok(audit.issues.some(issue => issue.includes('Mandatory context item')))
})

test('health audit requires assistant tool calls and tool results to remain paired', () => {
  const parent = item({
    id: 'assistant-tools', text: 'assistant requested tools', preservation: 'P4',
    embeddedToolCallIds: ['call-1', 'call-2']
  })
  const result1 = item({
    id: 'tool-result-1', text: 'result one', preservation: 'P4', toolResultCallId: 'call-1'
  })
  const result2 = item({
    id: 'tool-result-2', text: 'result two', preservation: 'P4', toolResultCallId: 'call-2'
  })
  const passed = auditContext({
    items: [parent, result1, result2],
    selectedItemIds: ['assistant-tools', 'tool-result-1', 'tool-result-2'],
    boundary: safeBoundary
  })
  assert.equal(passed.passed, true)

  const missing = auditContext({
    items: [parent, result1],
    selectedItemIds: ['assistant-tools', 'tool-result-1'],
    boundary: safeBoundary
  })
  assert.equal(missing.passed, false)
  assert.ok(missing.issues.some(issue => issue.includes("call-2")))
})
