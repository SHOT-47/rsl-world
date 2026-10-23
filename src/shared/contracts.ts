/** Public, serializable contract between the renderer and Electron main process. */
export const IPC = {
  getBootstrap: 'app:get-bootstrap',
  chooseProjectRoot: 'project:choose-root',
  listTasks: 'task:list',
  createTask: 'task:create',
  cancelTask: 'task:cancel',
  resumeTask: 'task:resume',
  respondToApproval: 'approval:respond',
  listPendingApprovals: 'approval:list-pending',
  validateRsl: 'rsl:validate',
  validateCase: 'rsl:validate-case',
  initializeCase: 'rsl:initialize-case',
  exportRslSkill: 'rsl:export-skill',
  listEvents: 'runtime:list-events',
  inspectEvidenceFile: 'evidence:inspect-file',
  listEvidence: 'evidence:list',
  listProviders: 'provider:list',
  saveProvider: 'provider:save',
  deleteProvider: 'provider:delete',
  setActiveProvider: 'provider:set-active',
  testProvider: 'provider:test',
  runtimeEvent: 'runtime:event'
} as const

export type ApiErrorCode =
  | 'INVALID_INPUT'
  | 'UNAUTHORIZED_SENDER'
  | 'NOT_IMPLEMENTED'
  | 'NOT_FOUND'
  | 'POLICY_DENIED'
  | 'APPROVAL_REQUIRED'
  | 'CONFLICT'
  | 'INTERNAL'

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ApiErrorCode; message: string } }

export interface BootstrapInfo {
  appVersion: string
  platform: string
  rslVersion: string | null
  runtimeStatus: 'ready' | 'degraded'
  limitations: string[]
}

export interface ProjectRootSelection {
  cancelled: boolean
  path: string | null
}

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'interrupted'
  | 'outcome_uncertain'

export interface TaskSummary {
  id: string
  projectRoot: string
  title: string
  mode: 'coding' | 'rsl-investigation' | 'target-api' | 'provider-diagnostics'
  status: TaskStatus
  createdAt: string
  updatedAt: string
  checkpointVersion: number
  summary: string | null
}

export interface TargetApiScopeInput {
  /** Explicit API base URL. The main process normalizes and revalidates it. */
  baseUrl: string
  /** Relative paths under baseUrl; GET only; empty array means the base URL. */
  paths: string[]
  /** UI acknowledgement that the operator is authorized to inspect this target. */
  authorizationConfirmed: boolean
}

export interface TaskWorkflowConfig {
  /** Set by the main process only after explicit approval of the public search query. */
  priorArtSearchApproved?: boolean
  targetApi?: TargetApiScopeInput
}

export interface CreateTaskInput {
  projectRoot: string
  title: string
  prompt: string
  mode: TaskSummary['mode']
  workflowConfig?: TaskWorkflowConfig
}

export interface CancelTaskInput {
  taskId: string
}

export interface ApprovalResponseInput {
  requestId: string
  decision: 'approve' | 'deny'
}

export interface PendingApprovalSummary {
  id: string
  taskId: string
  summary: string
  target: string
  reason: string
  expectedImpact: string
  rollbackInfo: string | null
  actionDetails: string | null
  expiresAt: string
}

export interface RuntimeEvent {
  id: string
  taskId: string | null
  at: string
  kind: 'status' | 'activity' | 'approval' | 'evidence' | 'warning' | 'error'
  title: string
  detail?: string
}

export interface RslValidationResult {
  available: boolean
  version: string | null
  passed: boolean | null
  summary: string
  details: string[]
}

export interface CaseInitializationResult {
  created: boolean
  caseRoot: string | null
  summary: string
}

export interface RslExportResult {
  exported: boolean
  harness: string
  destination: string | null
  summary: string
  details: string[]
}

export type RslHarnessId = 'claude-code' | 'cursor' | 'codex' | 'gemini-cli' | 'copilot' | 'opencode' | 'cline' | 'windsurf' | 'grok-build' | 'generic'

export interface CaseValidationResult {
  available: boolean
  caseRoot: string | null
  passed: boolean
  summary: string
  errors: string[]
  counts?: Record<string, number>
}

export type ProviderKind = 'local' | 'cloud'

export interface ProviderConfigInput {
  id?: string
  name: string
  kind: ProviderKind
  baseUrl: string
  model: string
  /** Sent once over trusted IPC; main process encrypts it with OS-backed storage. Never returned. */
  apiKey?: string
  clearApiKey?: boolean
}

export interface ProviderSummary {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  model: string
  hasCredentials: boolean
  createdAt: string
  updatedAt: string
  active: boolean
}

export interface ProviderTestResult {
  ok: boolean
  endpoint: string
  latencyMs: number
  status: number | null
  models: Array<{ id: string; ownedBy?: string }>
  selectedModelAvailable: boolean | null
  summary: string
  details: string[]
}

export interface EvidenceArtifact {
  id: string
  projectRoot: string
  relativePath: string
  name: string
  suffix: string
  sizeBytes: number
  modifiedAt: string
  sha256: string
  createdAt: string
}

export interface WorkbenchApi {
  getBootstrap(): Promise<ApiResult<BootstrapInfo>>
  chooseProjectRoot(): Promise<ApiResult<ProjectRootSelection>>
  listTasks(projectRoot?: string): Promise<ApiResult<TaskSummary[]>>
  createTask(input: CreateTaskInput): Promise<ApiResult<TaskSummary>>
  cancelTask(input: CancelTaskInput): Promise<ApiResult<{ accepted: boolean }>>
  resumeTask(input: CancelTaskInput): Promise<ApiResult<TaskSummary>>
  respondToApproval(input: ApprovalResponseInput): Promise<ApiResult<{ accepted: boolean }>>
  listPendingApprovals(): Promise<ApiResult<PendingApprovalSummary[]>>
  validateRsl(): Promise<ApiResult<RslValidationResult>>
  validateCase(projectRoot: string): Promise<ApiResult<CaseValidationResult>>
  initializeCase(projectRoot: string): Promise<ApiResult<CaseInitializationResult>>
  exportRslSkill(harness: RslHarnessId): Promise<ApiResult<RslExportResult>>
  listEvents(): Promise<ApiResult<RuntimeEvent[]>>
  inspectEvidenceFile(projectRoot: string): Promise<ApiResult<EvidenceArtifact | null>>
  listEvidence(projectRoot: string): Promise<ApiResult<EvidenceArtifact[]>>
  listProviders(): Promise<ApiResult<ProviderSummary[]>>
  saveProvider(input: ProviderConfigInput): Promise<ApiResult<ProviderSummary>>
  deleteProvider(providerId: string): Promise<ApiResult<{ deleted: boolean }>>
  setActiveProvider(providerId: string | null): Promise<ApiResult<ProviderSummary | null>>
  testProvider(providerId: string): Promise<ApiResult<ProviderTestResult>>
  onRuntimeEvent(callback: (event: RuntimeEvent) => void): () => void
}

export const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data })
export const fail = (code: ApiErrorCode, message: string): ApiResult<never> => ({
  ok: false,
  error: { code, message }
})
