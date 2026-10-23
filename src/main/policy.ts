import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { redactSecrets } from './redaction.ts'

export type OperationKind =
  | 'read_file' | 'list_directory' | 'search_files' | 'read_project_metadata'
  | 'write_file' | 'delete_file' | 'execute_command' | 'network_request'
  | 'install_dependency' | 'credential_use' | 'credential_export' | 'policy_override'
  | 'outside_workspace' | 'disable_security'

export interface ProposedOperation {
  id: string
  kind: OperationKind
  summary: string
  target: string
  projectRoot: string
  parameters: Record<string, unknown>
  expectedImpact: string
  rollbackInfo?: string | null
  networkHost?: string | null
  httpMethod?: string | null
  transfersSensitiveData?: boolean
}

export interface RiskDecision {
  tier: 'low' | 'elevated' | 'prohibited'
  decision: 'allow' | 'require_approval' | 'deny'
  reason: string
}

export interface ApprovalPreview {
  operationHash: string
  summary: string
  target: string
  reason: string
  expectedImpact: string
  rollbackInfo: string | null
  actionDetails: string | null
}

const HARD_DENY = new Set<OperationKind>([
  'credential_export', 'policy_override', 'outside_workspace', 'disable_security'
])
const READ_ONLY = new Set<OperationKind>([
  'read_file', 'list_directory', 'search_files', 'read_project_metadata'
])

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, stableValue((value as Record<string, unknown>)[key])]))
  }
  return value
}

export function canonicalOperation(operation: ProposedOperation): string {
  return JSON.stringify(stableValue(operation))
}

export function hashOperation(operation: ProposedOperation): string {
  return createHash('sha256').update(canonicalOperation(operation), 'utf8').digest('hex')
}

export function isWithinWorkspace(candidatePath: string, workspaceRoot: string): boolean {
  if (!isAbsolute(candidatePath) || !isAbsolute(workspaceRoot)) return false
  const root = resolve(workspaceRoot)
  const candidate = resolve(candidatePath)
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

export function classifyOperation(
  operation: ProposedOperation,
  approvedNetworkHosts: ReadonlySet<string> = new Set()
): RiskDecision {
  if (HARD_DENY.has(operation.kind)) {
    return { tier: 'prohibited', decision: 'deny', reason: `Operation '${operation.kind}' is prohibited by the active security baseline.` }
  }
  if (!isWithinWorkspace(operation.projectRoot, operation.projectRoot)) {
    return { tier: 'prohibited', decision: 'deny', reason: 'Invalid workspace root.' }
  }
  if (operation.parameters.path && typeof operation.parameters.path === 'string') {
    const requestedPath = operation.parameters.path
    const relativeSegments = requestedPath.replace(/\\/g, '/').split('/')
    const escapes = isAbsolute(requestedPath)
      ? !isWithinWorkspace(requestedPath, operation.projectRoot)
      : requestedPath.startsWith('/') || requestedPath.startsWith('\\') || relativeSegments.some(segment => segment === '..' || segment === '')
    if (escapes) return { tier: 'prohibited', decision: 'deny', reason: 'The requested path escapes the configured project workspace or is not normalized.' }
  }
  if (operation.kind === 'credential_use') {
    return { tier: 'elevated', decision: 'require_approval', reason: 'Credential use requires a task-scoped grant and explicit purpose.' }
  }
  if (operation.kind === 'network_request') {
    const host = (operation.networkHost ?? '').toLowerCase().replace(/\.$/, '')
    const hostApproved = host.length > 0 && approvedNetworkHosts.has(host)
    if (operation.transfersSensitiveData || !hostApproved || !['GET', 'HEAD', 'OPTIONS'].includes((operation.httpMethod ?? '').toUpperCase())) {
      return { tier: 'elevated', decision: 'require_approval', reason: !hostApproved ? 'Destination is not allow-listed for this project.' : operation.transfersSensitiveData ? 'Sensitive data may leave the local workspace.' : 'Non-read-only network requests require approval.' }
    }
    return { tier: 'low', decision: 'allow', reason: 'Read-only request to an allow-listed destination.' }
  }
  if (READ_ONLY.has(operation.kind)) {
    return { tier: 'low', decision: 'allow', reason: 'Read-only operation inside the configured workspace.' }
  }
  return { tier: 'elevated', decision: 'require_approval', reason: 'Operation can mutate state or execute code and requires exact-action approval.' }
}

export function createApprovalPreview(operation: ProposedOperation): ApprovalPreview {
  return {
    operationHash: hashOperation(operation),
    summary: redactSecrets(operation.summary).value,
    target: redactSecrets(operation.target).value,
    reason: `Review the exact ${operation.kind} operation and its declared impact before authorization.`,
    expectedImpact: redactSecrets(operation.expectedImpact).value,
    rollbackInfo: operation.rollbackInfo ? redactSecrets(operation.rollbackInfo).value : null,
    actionDetails: typeof operation.parameters.contentPreview === 'string' ? redactSecrets(operation.parameters.contentPreview).value.slice(0, 200_000) : null
  }
}

/** Used both for persisted audit text and before rendering previews. */
export function redactOperationPreview(operation: ProposedOperation): ProposedOperation {
  return {
    ...operation,
    summary: redactSecrets(operation.summary).value,
    target: redactSecrets(operation.target).value,
    parameters: Object.fromEntries(Object.entries(operation.parameters).map(([key, value]) => [key, typeof value === 'string' ? redactSecrets(value).value : value])),
    expectedImpact: redactSecrets(operation.expectedImpact).value,
    rollbackInfo: operation.rollbackInfo ? redactSecrets(operation.rollbackInfo).value : null
  }
}
