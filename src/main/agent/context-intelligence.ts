import { createHash } from 'node:crypto'

export type PreservationClass = 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5'
export type ToolContextRole = 'call' | 'result'

export interface TokenBudgetProfile {
  /** Verified provider/model context capacity. Leave undefined when unknown. */
  contextWindowTokens?: number
  /** Explicit administrator/user safety cap; never inferred from the model name. */
  configuredContextCapTokens?: number
  maxOutputTokens: number
  reasoningReserveTokens?: number
  toolOverheadTokens?: number
  multimodalReserveTokens?: number
  uncertaintyMarginTokens?: number
}

export interface TokenBudget {
  status: 'ready' | 'profile-unknown' | 'invalid-profile' | 'no-input-budget'
  capacitySource: 'verified-model-profile' | 'configured-cap-only' | 'unknown'
  contextLimitTokens: number | null
  reservedTokens: number | null
  effectiveInputBudgetTokens: number | null
}

export interface TokenAssistShadowReport {
  mode: 'shadow'
  requestBytes: number
  estimatedPromptTokens: number
  estimateMethod: 'heuristic-characters-per-token'
  estimateConfidence: 'low'
  requestSha256: string
  budget: TokenBudget
  utilization: number | null
  recommendation: 'no-change' | 'review-context' | 'plan-cleanup' | 'budget-blocker' | 'configure-model-profile'
  requestChanged: false
}

export interface TokenUsageObservation {
  estimatedPromptTokens: number
  actualPromptTokens: number | null
  absoluteErrorTokens: number | null
  relativeError: number | null
  calibrationEligible: boolean
}

export interface ContextItem {
  id: string
  kind: string
  text: string
  preservation: PreservationClass
  sourceRefs: string[]
  factualClaim?: boolean
  required?: boolean
  active?: boolean
  relevance?: number
  freshness?: number
  evidenceQuality?: number
  toolCallId?: string
  toolRole?: ToolContextRole
  toolState?: 'pending' | 'resolved'
  embeddedToolCallIds?: string[]
  toolResultCallId?: string
}

export interface ContextBoundaryState {
  checkpointDurable: boolean
  operationInFlight: boolean
  sideEffectState: 'none' | 'known_complete' | 'known_not_started' | 'possible'
  pendingApprovalCount: number
}

export interface ContextAudit {
  passed: boolean
  issues: string[]
  selectedItemIds: string[]
}

export interface ContextSelectionPlan {
  status: 'ready' | 'profile-unknown' | 'blocked'
  selectedItemIds: string[]
  omittedItemIds: string[]
  estimatedTokens: number | null
  mandatoryTokens: number | null
  reasons: Record<string, string>
  blockers: string[]
}

export interface ContextCleanupProposal {
  status: 'ready' | 'blocked' | 'profile-unknown' | 'unsafe-boundary'
  baseVersion: number
  nextVersion: number
  beforeHash: string
  candidateHash: string | null
  activeItemIds: string[]
  archivedItemIds: string[]
  duplicateOf: Record<string, string>
  audit: ContextAudit
  blockers: string[]
  committed: false
}

const DEFAULT_THRESHOLDS = { warn: 0.70, cleanup: 0.80, stop: 0.90 } as const

function isSafeTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function normalizeRatio(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Context ranking signals must be between 0 and 1.')
  return value
}

export function estimatePromptTokensHeuristically(text: string): { tokens: number; method: 'heuristic-characters-per-token'; confidence: 'low' } {
  if (typeof text !== 'string') throw new Error('Request text must be a string.')
  // This deliberately rough fallback is telemetry only; it is not safe for hard budget enforcement.
  const codePoints = Array.from(text).length
  return { tokens: Math.ceil(codePoints / 3.5), method: 'heuristic-characters-per-token', confidence: 'low' }
}

export function calculateTokenBudget(profile?: TokenBudgetProfile | null): TokenBudget {
  if (!profile) {
    return { status: 'profile-unknown', capacitySource: 'unknown', contextLimitTokens: null, reservedTokens: null, effectiveInputBudgetTokens: null }
  }

  const values = [
    profile.contextWindowTokens, profile.configuredContextCapTokens, profile.maxOutputTokens,
    profile.reasoningReserveTokens ?? 0, profile.toolOverheadTokens ?? 0,
    profile.multimodalReserveTokens ?? 0, profile.uncertaintyMarginTokens ?? 0
  ]
  if (values.some(value => value !== undefined && !isSafeTokenCount(value)) || !isSafeTokenCount(profile.maxOutputTokens) || profile.maxOutputTokens === 0) {
    return { status: 'invalid-profile', capacitySource: 'unknown', contextLimitTokens: null, reservedTokens: null, effectiveInputBudgetTokens: null }
  }

  const modelLimit = profile.contextWindowTokens
  const configuredCap = profile.configuredContextCapTokens
  const contextLimitTokens = modelLimit !== undefined && configuredCap !== undefined
    ? Math.min(modelLimit, configuredCap)
    : modelLimit ?? configuredCap ?? null
  if (contextLimitTokens === null) {
    return { status: 'profile-unknown', capacitySource: 'unknown', contextLimitTokens: null, reservedTokens: null, effectiveInputBudgetTokens: null }
  }

  const reservedTokens = profile.maxOutputTokens
    + (profile.reasoningReserveTokens ?? 0)
    + (profile.toolOverheadTokens ?? 0)
    + (profile.multimodalReserveTokens ?? 0)
    + (profile.uncertaintyMarginTokens ?? 0)
  const effectiveInputBudgetTokens = contextLimitTokens - reservedTokens
  if (effectiveInputBudgetTokens <= 0) {
    return {
      status: 'no-input-budget',
      capacitySource: modelLimit === undefined ? 'configured-cap-only' : 'verified-model-profile',
      contextLimitTokens, reservedTokens, effectiveInputBudgetTokens
    }
  }
  return {
    status: 'ready',
    capacitySource: modelLimit === undefined ? 'configured-cap-only' : 'verified-model-profile',
    contextLimitTokens, reservedTokens, effectiveInputBudgetTokens
  }
}

export function createTokenAssistShadowReport(input: {
  requestText: string
  profile?: TokenBudgetProfile | null
}): TokenAssistShadowReport {
  if (typeof input.requestText !== 'string') throw new Error('Request text must be a string.')
  const estimate = estimatePromptTokensHeuristically(input.requestText)
  const budget = calculateTokenBudget(input.profile)
  const requestBytes = new TextEncoder().encode(input.requestText).length
  const utilization = budget.effectiveInputBudgetTokens && budget.effectiveInputBudgetTokens > 0
    ? estimate.tokens / budget.effectiveInputBudgetTokens
    : null

  let recommendation: TokenAssistShadowReport['recommendation'] = 'no-change'
  if (budget.status === 'profile-unknown') recommendation = 'configure-model-profile'
  else if (budget.status === 'invalid-profile' || budget.status === 'no-input-budget') recommendation = 'budget-blocker'
  else if (utilization !== null && utilization >= DEFAULT_THRESHOLDS.stop) recommendation = 'budget-blocker'
  else if (utilization !== null && utilization >= DEFAULT_THRESHOLDS.cleanup) recommendation = 'plan-cleanup'
  else if (utilization !== null && utilization >= DEFAULT_THRESHOLDS.warn) recommendation = 'review-context'

  return {
    mode: 'shadow', requestBytes, estimatedPromptTokens: estimate.tokens,
    estimateMethod: estimate.method, estimateConfidence: estimate.confidence,
    requestSha256: createHash('sha256').update(input.requestText, 'utf8').digest('hex'),
    budget, utilization, recommendation, requestChanged: false
  }
}

export function reconcileTokenUsage(
  report: TokenAssistShadowReport,
  actualPromptTokens: number | undefined
): TokenUsageObservation {
  if (!isSafeTokenCount(actualPromptTokens)) {
    return { estimatedPromptTokens: report.estimatedPromptTokens, actualPromptTokens: null, absoluteErrorTokens: null, relativeError: null, calibrationEligible: false }
  }
  const absoluteErrorTokens = Math.abs(report.estimatedPromptTokens - actualPromptTokens)
  const relativeError = actualPromptTokens === 0
    ? (report.estimatedPromptTokens === 0 ? 0 : null)
    : absoluteErrorTokens / actualPromptTokens
  return {
    estimatedPromptTokens: report.estimatedPromptTokens, actualPromptTokens,
    absoluteErrorTokens, relativeError, calibrationEligible: actualPromptTokens > 0
  }
}

function isMandatory(item: ContextItem): boolean {
  return item.preservation === 'P0' || item.preservation === 'P1' || item.preservation === 'P2' || item.required === true
}

function rank(item: ContextItem): number {
  const relevance = normalizeRatio(item.relevance, 0.5)
  const freshness = normalizeRatio(item.freshness, 0.5)
  const evidence = normalizeRatio(item.evidenceQuality, item.sourceRefs.length > 0 ? 0.75 : 0.25)
  return relevance * 0.60 + freshness * 0.15 + evidence * 0.25
}

export function planContextSelection(input: {
  items: ContextItem[]
  effectiveInputBudgetTokens: number | null
  countTokens: (text: string) => number | undefined
}): ContextSelectionPlan {
  const { items, effectiveInputBudgetTokens, countTokens } = input
  const ids = new Set<string>()
  for (const item of items) {
    if (!item.id || ids.has(item.id)) throw new Error('Context item IDs must be unique and non-empty.')
    ids.add(item.id)
  }
  if (effectiveInputBudgetTokens === null) {
    return { status: 'profile-unknown', selectedItemIds: items.filter(item => item.active !== false).map(item => item.id),
      omittedItemIds: [], estimatedTokens: null, mandatoryTokens: null, reasons: {}, blockers: ['Verified or configured context capacity is unavailable.'] }
  }
  if (!isSafeTokenCount(effectiveInputBudgetTokens) || effectiveInputBudgetTokens === 0) {
    return { status: 'blocked', selectedItemIds: [], omittedItemIds: items.map(item => item.id),
      estimatedTokens: null, mandatoryTokens: null, reasons: {}, blockers: ['Effective input budget is invalid or exhausted.'] }
  }

  const active = items.filter(item => item.active !== false)
  const costs = new Map<string, number>()
  const blockers: string[] = []
  for (const item of active) {
    const cost = countTokens(item.text)
    if (!isSafeTokenCount(cost)) {
      if (isMandatory(item)) blockers.push(`Mandatory item '${item.id}' has no defensible token count.`)
      continue
    }
    costs.set(item.id, cost)
  }

  const mandatory = active.filter(isMandatory)
  const mandatoryTokens = mandatory.reduce((sum, item) => sum + (costs.get(item.id) ?? 0), 0)
  if (blockers.length) {
    return { status: 'blocked', selectedItemIds: [], omittedItemIds: active.map(item => item.id), estimatedTokens: null, mandatoryTokens, reasons: {}, blockers }
  }
  if (mandatoryTokens > effectiveInputBudgetTokens) {
    return { status: 'blocked', selectedItemIds: mandatory.map(item => item.id), omittedItemIds: active.filter(item => !isMandatory(item)).map(item => item.id),
      estimatedTokens: mandatoryTokens, mandatoryTokens, reasons: {}, blockers: ['Protected context exceeds the effective input budget; do not drop protected information.'] }
  }

  const selected = new Set(mandatory.map(item => item.id))
  const reasons: Record<string, string> = {}
  for (const item of mandatory) reasons[item.id] = 'mandatory-preservation'
  let used = mandatoryTokens
  const optional = active.filter(item => !isMandatory(item) && costs.has(item.id))
    .sort((left, right) => {
      const leftScore = rank(left) / Math.max(1, costs.get(left.id) ?? 1)
      const rightScore = rank(right) / Math.max(1, costs.get(right.id) ?? 1)
      return rightScore - leftScore || left.id.localeCompare(right.id)
    })
  for (const item of optional) {
    const cost = costs.get(item.id)!
    if (used + cost <= effectiveInputBudgetTokens) {
      selected.add(item.id)
      used += cost
      reasons[item.id] = 'best-ranked optional context within budget'
    } else reasons[item.id] = 'omitted to preserve budget for higher-value context'
  }
  for (const item of active.filter(item => !selected.has(item.id) && !reasons[item.id])) {
    reasons[item.id] = 'omitted because a safe token estimate was unavailable'
  }
  return { status: 'ready', selectedItemIds: active.filter(item => selected.has(item.id)).map(item => item.id),
    omittedItemIds: active.filter(item => !selected.has(item.id)).map(item => item.id),
    estimatedTokens: used, mandatoryTokens, reasons, blockers: [] }
}

export function auditContext(input: {
  items: ContextItem[]
  selectedItemIds: string[]
  boundary: ContextBoundaryState
}): ContextAudit {
  const issues: string[] = []
  const selected = new Set(input.selectedItemIds)
  const byId = new Map(input.items.map(item => [item.id, item]))
  if (selected.size !== input.selectedItemIds.length) issues.push('Selected context contains duplicate item IDs.')
  for (const id of selected) if (!byId.has(id)) issues.push(`Selected context references unknown item '${id}'.`)

  for (const item of input.items.filter(item => item.active !== false)) {
    if (isMandatory(item) && !selected.has(item.id)) issues.push(`Mandatory context item '${item.id}' would be lost.`)
  }
  for (const item of input.items.filter(item => selected.has(item.id))) {
    if (item.factualClaim && item.sourceRefs.length === 0) issues.push(`Factual item '${item.id}' has no provenance source.`)
    if (item.toolRole && !item.toolCallId) issues.push(`Tool item '${item.id}' has no stable tool-call ID.`)
    if (item.toolRole === 'call') {
      if (item.toolState !== 'resolved') issues.push(`Tool call '${item.id}' is unresolved.`)
      const result = input.items.find(candidate => candidate.toolRole === 'result' && candidate.toolCallId === item.toolCallId)
      if (!result || !selected.has(result.id)) issues.push(`Tool call '${item.id}' has no selected matching result.`)
    }
    if (item.toolRole === 'result') {
      const call = input.items.find(candidate => candidate.toolRole === 'call' && candidate.toolCallId === item.toolCallId)
      if (!call || !selected.has(call.id)) issues.push(`Tool result '${item.id}' has no selected matching call.`)
    }
    for (const callId of item.embeddedToolCallIds ?? []) {
      const result = input.items.find(candidate => candidate.toolResultCallId === callId)
      if (!result || !selected.has(result.id)) issues.push(`Assistant message '${item.id}' is missing tool result '${callId}'.`)
    }
    if (item.toolResultCallId) {
      const parent = input.items.find(candidate => (candidate.embeddedToolCallIds ?? []).includes(item.toolResultCallId as string))
      if (!parent || !selected.has(parent.id)) issues.push(`Tool result '${item.id}' has no selected assistant tool-call message.`)
    }
  }

  if (!input.boundary.checkpointDurable) issues.push('The latest task checkpoint is not durable.')
  if (input.boundary.operationInFlight || input.boundary.sideEffectState === 'possible') issues.push('A side effect is in flight or has an uncertain outcome.')
  if (input.boundary.pendingApprovalCount > 0) issues.push('An approval is pending; context compaction is not a safe boundary.')
  return { passed: issues.length === 0, issues, selectedItemIds: [...selected] }
}

function hashSnapshot(items: ContextItem[], ids: string[]): string {
  const selected = new Set(ids)
  const payload = items.filter(item => selected.has(item.id)).map(item => ({
    id: item.id, kind: item.kind, text: item.text, preservation: item.preservation,
    sourceRefs: item.sourceRefs, factualClaim: item.factualClaim === true, required: item.required === true,
    toolCallId: item.toolCallId ?? null, toolRole: item.toolRole ?? null, toolState: item.toolState ?? null
  }))
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex')
}

/** Produces a reversible proposal only. It never mutates the ledger or deletes source records. */
export function proposeContextCleanup(input: {
  items: ContextItem[]
  baseVersion: number
  effectiveInputBudgetTokens: number | null
  countTokens: (text: string) => number | undefined
  boundary: ContextBoundaryState
}): ContextCleanupProposal {
  if (!Number.isSafeInteger(input.baseVersion) || input.baseVersion < 0) throw new Error('Context snapshot version is invalid.')
  const currentIds = input.items.filter(item => item.active !== false).map(item => item.id)
  const beforeHash = hashSnapshot(input.items, currentIds)
  const unsafe = !input.boundary.checkpointDurable || input.boundary.operationInFlight
    || input.boundary.sideEffectState === 'possible' || input.boundary.pendingApprovalCount > 0
  if (unsafe) {
    const audit = auditContext({ items: input.items, selectedItemIds: currentIds, boundary: input.boundary })
    return { status: 'unsafe-boundary', baseVersion: input.baseVersion, nextVersion: input.baseVersion + 1,
      beforeHash, candidateHash: null, activeItemIds: currentIds, archivedItemIds: [],
      duplicateOf: {}, audit, blockers: audit.issues, committed: false }
  }

  const budgetPlan = planContextSelection({ items: input.items, effectiveInputBudgetTokens: input.effectiveInputBudgetTokens, countTokens: input.countTokens })
  if (budgetPlan.status !== 'ready') {
    return { status: budgetPlan.status === 'profile-unknown' ? 'profile-unknown' : 'blocked',
      baseVersion: input.baseVersion, nextVersion: input.baseVersion + 1,
      beforeHash, candidateHash: null, activeItemIds: currentIds, archivedItemIds: [],
      duplicateOf: {}, audit: auditContext({ items: input.items, selectedItemIds: currentIds, boundary: input.boundary }),
      blockers: budgetPlan.blockers, committed: false }
  }

  const active = new Set(budgetPlan.selectedItemIds)
  const seen = new Map<string, string>()
  const duplicateOf: Record<string, string> = {}
  // Only P4/P5 are eligible for deterministic duplicate removal. P0-P3 are never deduplicated.
  for (const item of input.items.filter(item => active.has(item.id) && (item.preservation === 'P4' || item.preservation === 'P5'))) {
    const normalized = item.text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
    const key = `${item.kind}\u0000${normalized}`
    const existing = seen.get(key)
    if (existing && !item.required) {
      active.delete(item.id)
      duplicateOf[item.id] = existing
    } else if (!existing) seen.set(key, item.id)
  }

  const activeItemIds = input.items.filter(item => active.has(item.id)).map(item => item.id)
  const archivedItemIds = currentIds.filter(id => !active.has(id))
  const audit = auditContext({ items: input.items, selectedItemIds: activeItemIds, boundary: input.boundary })
  const candidateHash = hashSnapshot(input.items, activeItemIds)
  const blockers = audit.issues
  return { status: audit.passed ? 'ready' : 'blocked', baseVersion: input.baseVersion, nextVersion: input.baseVersion + 1,
    beforeHash, candidateHash: audit.passed ? candidateHash : null, activeItemIds: audit.passed ? activeItemIds : currentIds,
    archivedItemIds: audit.passed ? archivedItemIds : [], duplicateOf: audit.passed ? duplicateOf : {},
    audit, blockers, committed: false }
}

export function getContextHealthSummary(audit: ContextAudit): { status: 'healthy' | 'degraded'; issueCount: number; summary: string } {
  return audit.passed
    ? { status: 'healthy', issueCount: 0, summary: 'Protected context, provenance, tool pairing and lifecycle boundary checks passed.' }
    : { status: 'degraded', issueCount: audit.issues.length, summary: 'Context integrity checks failed; retain the previous snapshot and do not commit cleanup.' }
}
