import type { TaskStatus } from '@shared/contracts'

export type RecoveryStatus = 'interrupted' | 'outcome_uncertain'

export interface RecoveryAssessment {
  status: RecoveryStatus
  reason: string
}

export function assessRecovery(checkpointJson: string | null, previousStatus: 'queued' | 'running' | 'waiting_approval'): RecoveryAssessment {
  if (!checkpointJson) {
    if (previousStatus === 'running') return { status: 'outcome_uncertain', reason: 'No durable checkpoint exists for a task that was running; reconcile side effects before retrying.' }
    if (previousStatus === 'queued') return { status: 'interrupted', reason: 'The task was queued when the app closed; it was not resumed automatically and requires explicit user resumption.' }
    return { status: 'interrupted', reason: 'The task was waiting for approval when the app closed; approvals are invalidated and must be reviewed again.' }
  }
  try {
    const state = JSON.parse(checkpointJson) as { operationInFlight?: unknown; sideEffectState?: unknown }
    if (state.operationInFlight === true || state.sideEffectState === 'possible') {
      return { status: 'outcome_uncertain', reason: 'The previous process ended during a possibly side-effecting operation. Reconcile the target state before retrying.' }
    }
    return { status: 'interrupted', reason: 'Resume from the last integrity-checked checkpoint after rechecking capabilities and permissions.' }
  } catch {
    return { status: 'outcome_uncertain', reason: 'The checkpoint could not be parsed; do not replay actions until the task state is reconciled.' }
  }
}

const TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  queued: new Set(['queued', 'running', 'waiting_approval', 'blocked', 'cancelled', 'failed']),
  running: new Set(['running', 'waiting_approval', 'succeeded', 'failed', 'cancelled', 'interrupted', 'outcome_uncertain', 'blocked']),
  waiting_approval: new Set(['waiting_approval', 'running', 'blocked', 'cancelled', 'interrupted', 'outcome_uncertain']),
  succeeded: new Set(['succeeded']),
  failed: new Set(['failed', 'queued']),
  cancelled: new Set(['cancelled']),
  blocked: new Set(['blocked', 'queued', 'cancelled']),
  interrupted: new Set(['interrupted', 'queued', 'running', 'cancelled', 'outcome_uncertain']),
  outcome_uncertain: new Set(['outcome_uncertain', 'blocked', 'cancelled'])
}

export function isValidTaskTransition(previous: TaskStatus, next: TaskStatus): boolean {
  return TRANSITIONS[previous].has(next)
}

export function nextCheckpointVersion(previous: number): number {
  if (!Number.isSafeInteger(previous) || previous < 0) throw new Error('Invalid existing checkpoint version.')
  return previous + 1
}

export type ApprovalDisposition = 'consume' | 'not-approved' | 'expired' | 'mismatch'

export function evaluateApproval(input: {
  status: string
  expiresAt: string
  storedOperationHash: string
  currentOperationHash: string
  nowMs?: number
}): ApprovalDisposition {
  if (input.status !== 'approved') return 'not-approved'
  const expiry = Date.parse(input.expiresAt)
  if (!Number.isFinite(expiry) || expiry <= (input.nowMs ?? Date.now())) return 'expired'
  if (input.storedOperationHash !== input.currentOperationHash) return 'mismatch'
  return 'consume'
}

export function approvalCanBeDecided(status: string, expiresAt: string, nowMs = Date.now()): boolean {
  const expiry = Date.parse(expiresAt)
  return status === 'pending' && Number.isFinite(expiry) && expiry > nowMs
}
