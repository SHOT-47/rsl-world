import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { sanitizeJson, redactSecrets } from './redaction.ts'
import type { ApprovalPreview, ProposedOperation } from './policy.ts'
import { createApprovalPreview, hashOperation } from './policy.ts'
import { approvalCanBeDecided, assessRecovery, evaluateApproval, isValidTaskTransition, nextCheckpointVersion } from './task-state.ts'
import type { CreateTaskInput, EvidenceArtifact, RuntimeEvent, TaskStatus, TaskSummary, TaskWorkflowConfig } from '@shared/contracts'

export interface CheckpointChatToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface CheckpointChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  name?: string
  tool_call_id?: string
  tool_calls?: CheckpointChatToolCall[]
}

export interface TaskCheckpoint {
  schemaVersion: 1
  taskId: string
  status: TaskStatus
  stage: 'intake' | 'planning' | 'tool_execution' | 'verification' | 'packaging'
  createdAt: string
  promptRedacted: boolean
  capabilityDetectionRequired: boolean
  priorArtCheckRequired: boolean
  operationInFlight: boolean
  sideEffectState: 'none' | 'known_complete' | 'known_not_started' | 'possible'
  completedActions: string[]
  pendingApprovalIds: string[]
  notes: string[]
  /** Bounded, secret-redacted model transcript for safe resume. Never contains provider credentials. */
  conversation?: CheckpointChatMessage[]
}

export interface ApprovalRecord extends ApprovalPreview {
  id: string
  taskId: string
  status: 'pending' | 'approved' | 'denied' | 'consumed' | 'expired'
  createdAt: string
  expiresAt: string
}

export interface TaskExecutionRecord { id: string; projectRoot: string; title: string; prompt: string; mode: TaskSummary['mode']; status: TaskStatus; checkpointVersion: number; workflowConfig: TaskWorkflowConfig }

export interface PendingApprovalSummary { id: string; taskId: string; summary: string; target: string; reason: string; expectedImpact: string; rollbackInfo: string | null; actionDetails: string | null; expiresAt: string }

interface TaskRow {
  id: string
  project_root: string
  title: string
  prompt_redacted: string
  prompt_sha256: string
  mode: TaskSummary['mode']
  status: TaskStatus
  created_at: string
  updated_at: string
  checkpoint_version: number
  summary: string | null
}

const TASK_COLUMNS = 'id, project_root, title, prompt_redacted, prompt_sha256, mode, status, created_at, updated_at, checkpoint_version, summary'
const TASK_STATUSES: TaskStatus[] = ['queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled', 'blocked', 'interrupted', 'outcome_uncertain']

export class TaskStore {
  readonly database: Database.Database

  constructor(databasePath: string, schemaPath: string) {
    mkdirSync(dirname(databasePath), { recursive: true })
    this.database = new Database(databasePath)
    this.database.pragma('journal_mode = WAL')
    this.database.pragma('foreign_keys = ON')
    this.database.pragma('busy_timeout = 5000')
    this.database.pragma('synchronous = FULL')
    const schemaDir = dirname(schemaPath)
    const migrations = readdirSync(schemaDir)
      .filter(name => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
      .sort((a, b) => Number(a.split('_', 1)[0]) - Number(b.split('_', 1)[0]))
    const files = migrations.length ? migrations.map(name => join(schemaDir, name)) : [schemaPath]
    for (const file of files) {
      const fileName = basename(file)
      const versionMatch = /^(\d+)_/.exec(fileName)
      const version = versionMatch ? Number(versionMatch[1]) : Number.NaN
      const versionRow = (() => {
        try { return this.database.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as { value: string } | undefined }
        catch { return undefined }
      })()
      const currentVersion = Number(versionRow?.value ?? 0)
      if (version <= currentVersion) continue
      if (version !== currentVersion + 1) throw new Error(`Database migration gap: found ${fileName} after schema version ${currentVersion}.`)
      const migration = readFileSync(file, 'utf8')
      this.database.transaction(() => this.database.exec(migration))()
      const afterRow = this.database.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as { value: string } | undefined
      if (Number(afterRow?.value) !== version) throw new Error(`Migration ${fileName} did not advance schema version to ${version}.`)
    }
    this.expireApprovalsOnStartup()
    this.recoverInterruptedTasks()
  }

  close(): void { this.database.close() }

  private expireApprovalsOnStartup(): void {
    const now = new Date().toISOString()
    this.database.prepare("UPDATE approvals SET status='expired' WHERE status IN ('pending','approved')").run()
    this.appendEvent(null, 'warning', 'Prior approval grants expired', `Pending and approved one-shot approvals were invalidated on startup at ${now}.`)
  }

  private recoverInterruptedTasks(): void {
    const rows = this.database.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE status IN ('queued','running','waiting_approval')`).all() as TaskRow[]
    const transaction = this.database.transaction(() => {
      for (const row of rows) {
        let recovery: ReturnType<typeof assessRecovery>
        try {
          const checkpoint = this.getLatestCheckpoint(row.id)
          recovery = assessRecovery(checkpoint?.state_json ?? null, row.status as 'queued' | 'running' | 'waiting_approval')
        } catch {
          recovery = { status: 'outcome_uncertain', reason: 'Checkpoint integrity verification failed. Reconcile the target state before retrying.' }
        }
        const status = recovery.status
        const uncertain = status === 'outcome_uncertain'
        const summary = recovery.reason
        this.database.prepare('UPDATE tasks SET status=?, updated_at=?, summary=? WHERE id=?').run(status, new Date().toISOString(), summary, row.id)
        this.appendEvent(row.id, uncertain ? 'warning' : 'status', uncertain ? 'Operation outcome uncertain' : 'Task interrupted', summary)
      }
    })
    transaction()
  }

  registerProject(root: string): { root: string; displayName: string; rslVersionPin: string } {
    const displayName = root.split(/[\\/]/).filter(Boolean).at(-1) || root
    const now = new Date().toISOString()
    this.database.prepare(`INSERT INTO projects(root, display_name, created_at, last_opened_at)
      VALUES(?, ?, ?, ?) ON CONFLICT(root) DO UPDATE SET last_opened_at=excluded.last_opened_at`)
      .run(root, displayName, now, now)
    const row = this.database.prepare('SELECT root, display_name, rsl_version_pin FROM projects WHERE root=?').get(root) as { root: string; display_name: string; rsl_version_pin: string }
    this.appendEvent(null, 'activity', 'Project registered', 'The selected project root is now available to the local Workbench runtime.')
    return { root: row.root, displayName: row.display_name, rslVersionPin: row.rsl_version_pin }
  }

  hasProject(root: string): boolean {
    return Boolean(this.database.prepare('SELECT 1 FROM projects WHERE root=?').get(root))
  }

  listProjects(): Array<{ root: string; displayName: string; rslVersionPin: string }> {
    const rows = this.database.prepare('SELECT root, display_name, rsl_version_pin FROM projects ORDER BY last_opened_at DESC').all() as Array<{ root: string; display_name: string; rsl_version_pin: string }>
    return rows.map(row => ({ root: row.root, displayName: row.display_name, rslVersionPin: row.rsl_version_pin }))
  }

  createTask(input: CreateTaskInput, availability: { ready: boolean; reason?: string }): TaskSummary {
    if (!this.hasProject(input.projectRoot)) throw new Error('Project folder must be selected and registered before creating a task.')
    const now = new Date().toISOString()
    const id = randomUUID()
    const safePrompt = redactSecrets(input.prompt)
    const promptHash = createHash('sha256').update(safePrompt.value, 'utf8').digest('hex')
    const status: TaskStatus = availability.ready ? 'queued' : 'blocked'
    const summary = availability.ready ? 'Queued for capability detection and route selection.' : (availability.reason ?? 'No compatible model route is available; task saved without execution.')
    const initial: TaskCheckpoint = {
      schemaVersion: 1, taskId: id, status, stage: 'intake', createdAt: now,
      promptRedacted: safePrompt.changed,
      capabilityDetectionRequired: true,
      priorArtCheckRequired: input.mode === 'rsl-investigation',
      operationInFlight: false,
      sideEffectState: 'none',
      completedActions: [], pendingApprovalIds: [],
      notes: safePrompt.changed ? ['Sensitive-looking values were redacted before persistence. Provide credential references through the credential broker rather than embedding secrets in prompts.'] : []
    }
    const snapshot = JSON.stringify(sanitizeJson(initial))
    const checkpointHash = createHash('sha256').update(snapshot, 'utf8').digest('hex')
    const transaction = this.database.transaction(() => {
      this.database.prepare(`INSERT INTO tasks(id, project_root, title, prompt_redacted, prompt_sha256, mode, status, created_at, updated_at, checkpoint_version, summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
        .run(id, input.projectRoot, redactSecrets(input.title).value, safePrompt.value, promptHash, input.mode, status, now, now, summary)
      const workflowConfig = JSON.stringify(sanitizeJson(input.workflowConfig ?? {}))
      const workflowConfigHash = createHash('sha256').update(workflowConfig, 'utf8').digest('hex')
      this.database.prepare('UPDATE tasks SET workflow_config=?, workflow_config_sha256=? WHERE id=?').run(workflowConfig, workflowConfigHash, id)
      this.database.prepare('INSERT INTO checkpoints(task_id, version, created_at, state_json, sha256) VALUES(?, 1, ?, ?, ?)')
        .run(id, now, snapshot, checkpointHash)
      this.appendEvent(id, status === 'queued' ? 'status' : 'warning', status === 'queued' ? 'Task queued' : 'Task saved but blocked', summary)
    })
    transaction()
    const row = this.database.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id=?`).get(id) as TaskRow
    return this.toTaskSummary(row)
  }

  listTasks(projectRoot?: string): TaskSummary[] {
    const rows = projectRoot
      ? this.database.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE project_root=? ORDER BY updated_at DESC LIMIT 200`).all(projectRoot) as TaskRow[]
      : this.database.prepare(`SELECT ${TASK_COLUMNS} FROM tasks ORDER BY updated_at DESC LIMIT 200`).all() as TaskRow[]
    return rows.map(row => this.toTaskSummary(row))
  }

  getTask(taskId: string): TaskSummary | null {
    const row = this.database.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id=?`).get(taskId) as TaskRow | undefined
    return row ? this.toTaskSummary(row) : null
  }

  getExecutionRecord(taskId: string): TaskExecutionRecord | null {
    const row = this.database.prepare(`SELECT id, project_root, title, prompt_redacted, prompt_sha256, mode, status, checkpoint_version, workflow_config, workflow_config_sha256 FROM tasks WHERE id=?`).get(taskId) as { id: string; project_root: string; title: string; prompt_redacted: string; prompt_sha256: string; mode: TaskSummary['mode']; status: TaskStatus; checkpoint_version: number; workflow_config: string; workflow_config_sha256: string } | undefined
    if (!row) return null
    const digest = createHash('sha256').update(row.prompt_redacted, 'utf8').digest('hex')
    if (digest !== row.prompt_sha256) throw new Error('Stored task prompt failed its integrity check.')
    const workflowConfigHash = createHash('sha256').update(row.workflow_config, 'utf8').digest('hex')
    if (row.workflow_config_sha256) {
      if (workflowConfigHash !== row.workflow_config_sha256) throw new Error('Stored workflow configuration failed its integrity check.')
    } else if (row.workflow_config !== '{}') {
      // Legacy records created before migration 006 are only accepted when they contain no scoped authority.
      throw new Error('Legacy task contains an unverified workflow configuration and must not execute.')
    }
    let workflowConfig: TaskWorkflowConfig = {}
    try { workflowConfig = JSON.parse(row.workflow_config) as TaskWorkflowConfig } catch { throw new Error('Stored workflow configuration is invalid.') }
    return { id: row.id, projectRoot: row.project_root, title: row.title, prompt: row.prompt_redacted, mode: row.mode, status: row.status, checkpointVersion: row.checkpoint_version, workflowConfig }
  }

  prepareTaskForResume(taskId: string): TaskSummary {
    const task = this.getTask(taskId)
    if (!task) throw new Error('Task not found.')
    if (!['interrupted', 'blocked'].includes(task.status)) throw new Error('Only interrupted or blocked tasks can be resumed.')
    const checkpointRow = this.getLatestCheckpoint(taskId)
    if (!checkpointRow) throw new Error('No integrity-checked checkpoint exists; task cannot be resumed safely.')
    const checkpoint = JSON.parse(checkpointRow.state_json) as TaskCheckpoint
    if (checkpoint.taskId !== taskId || checkpoint.schemaVersion !== 1) throw new Error('Checkpoint identity or schema version is invalid.')
    if (checkpoint.operationInFlight || checkpoint.sideEffectState === 'possible') {
      throw new Error('A side effect may be incomplete. Reconcile the target state before retrying; this task cannot be resumed automatically.')
    }
    if (!['coding', 'rsl-investigation', 'target-api'].includes(task.mode)) {
      throw new Error('This task mode does not support resume yet.')
    }
    checkpoint.status = 'queued'
    checkpoint.pendingApprovalIds = []
    checkpoint.operationInFlight = false
    // Approval records are single-use and never survive an interruption or resume.
    this.database.prepare("UPDATE approvals SET status='expired', decided_at=? WHERE task_id=? AND status IN ('pending','approved')").run(new Date().toISOString(), taskId)
    this.writeCheckpoint(taskId, {
      status: 'queued', stage: checkpoint.stage, promptRedacted: checkpoint.promptRedacted,
      capabilityDetectionRequired: checkpoint.capabilityDetectionRequired,
      priorArtCheckRequired: checkpoint.priorArtCheckRequired, operationInFlight: false,
      sideEffectState: checkpoint.sideEffectState, completedActions: checkpoint.completedActions.slice(-200),
      pendingApprovalIds: [], notes: [...checkpoint.notes, 'Resumed from an integrity-checked checkpoint after renewed policy checks.'].slice(-50),
      conversation: Array.isArray(checkpoint.conversation) ? checkpoint.conversation.slice(-80) : undefined
    }, 'Task re-queued from a validated checkpoint. Previous approvals were invalidated.')
    this.appendEvent(taskId, 'status', 'Task prepared for resume', 'A validated checkpoint was selected; approval grants were invalidated and will be requested again as needed.')
    const resumed = this.getTask(taskId)
    if (!resumed) throw new Error('Task disappeared during resume.')
    return resumed
  }

  listPendingApprovals(): PendingApprovalSummary[] {
    const rows = this.database.prepare("SELECT id,task_id,summary_redacted,target_redacted,reason_redacted,expected_impact_redacted,rollback_info_redacted,action_details_redacted,expires_at FROM approvals WHERE status='pending' ORDER BY created_at ASC LIMIT 100").all() as Array<Record<string, unknown>>
    return rows.map(row => ({ id: String(row.id), taskId: String(row.task_id), summary: String(row.summary_redacted), target: String(row.target_redacted), reason: String(row.reason_redacted), expectedImpact: String(row.expected_impact_redacted), rollbackInfo: row.rollback_info_redacted ? String(row.rollback_info_redacted) : null, actionDetails: row.action_details_redacted ? String(row.action_details_redacted) : null, expiresAt: String(row.expires_at) }))
  }


  hasActiveTasks(): boolean {
    const row = this.database.prepare("SELECT 1 FROM tasks WHERE status IN ('queued','running','waiting_approval') LIMIT 1").get()
    return Boolean(row)
  }

  cancelActiveTasks(): number {
    const rows = this.database.prepare("SELECT id FROM tasks WHERE status IN ('queued','running','waiting_approval')").all() as Array<{ id: string }>
    if (rows.length === 0) return 0
    const now = new Date().toISOString()
    const transaction = this.database.transaction(() => {
      for (const row of rows) {
        this.database.prepare("UPDATE tasks SET status='cancelled', updated_at=?, summary='Cancelled during application shutdown.' WHERE id=?").run(now, row.id)
        this.database.prepare("UPDATE approvals SET status='expired', decided_at=? WHERE task_id=? AND status IN ('pending','approved')").run(now, row.id)
        this.appendEvent(row.id, 'status', 'Task cancelled for shutdown', 'The app is shutting down. Any side effects from an interrupted action must be reconciled before retry.')
      }
    })
    transaction()
    return rows.length
  }

  recordEvidenceArtifact(input: {
    projectRoot: string; taskId?: string | null; relativePath: string; name: string; suffix: string;
    sizeBytes: number; modifiedAt: string; sha256: string; headerHex: string
  }): EvidenceArtifact {
    if (!this.hasProject(input.projectRoot)) throw new Error('Evidence must belong to a registered project.')
    if (!input.relativePath || input.relativePath.startsWith('/') || input.relativePath.startsWith('\\') || input.relativePath.split(/[\\/]/).some(segment => segment === '..' || segment === '.')) {
      throw new Error('Evidence path must be a normalized workspace-relative path.')
    }
    if (!/^[a-f0-9]{64}$/i.test(input.sha256)) throw new Error('Evidence SHA-256 must be a 64-character hexadecimal digest.')
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) throw new Error('Evidence size is invalid.')
    if (input.taskId && !this.getTask(input.taskId)) throw new Error('Evidence task does not exist.')
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    const safeName = redactSecrets(input.name).value
    const safeSuffix = redactSecrets(input.suffix).value
    const transaction = this.database.transaction(() => {
      this.database.prepare(`INSERT OR IGNORE INTO evidence_artifacts(id, project_root, task_id, relative_path, name, suffix, size_bytes, modified_at, sha256, header_hex, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.projectRoot, input.taskId ?? null, input.relativePath, safeName, safeSuffix, input.sizeBytes, input.modifiedAt, input.sha256.toLowerCase(), input.headerHex.slice(0, 64), createdAt)
      this.appendEvent(input.taskId ?? null, 'evidence', 'Evidence artifact hashed', `${input.relativePath} · SHA-256 ${input.sha256.toLowerCase()} · ${input.sizeBytes} bytes`)
    })
    transaction()
    const row = this.database.prepare('SELECT id, project_root, relative_path, name, suffix, size_bytes, modified_at, sha256, created_at FROM evidence_artifacts WHERE project_root=? AND relative_path=? AND sha256=?').get(input.projectRoot, input.relativePath, input.sha256.toLowerCase()) as Record<string, unknown>
    return {
      id: String(row.id), projectRoot: String(row.project_root), relativePath: String(row.relative_path),
      name: String(row.name), suffix: String(row.suffix), sizeBytes: Number(row.size_bytes),
      modifiedAt: String(row.modified_at), sha256: String(row.sha256), createdAt: String(row.created_at)
    }
  }

  listEvidenceArtifacts(projectRoot: string, limit = 100): EvidenceArtifact[] {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 500)
    const rows = this.database.prepare('SELECT id, project_root, relative_path, name, suffix, size_bytes, modified_at, sha256, created_at FROM evidence_artifacts WHERE project_root=? ORDER BY created_at DESC LIMIT ?').all(projectRoot, safeLimit) as Array<Record<string, unknown>>
    return rows.map(row => ({
      id: String(row.id), projectRoot: String(row.project_root), relativePath: String(row.relative_path),
      name: String(row.name), suffix: String(row.suffix), sizeBytes: Number(row.size_bytes),
      modifiedAt: String(row.modified_at), sha256: String(row.sha256), createdAt: String(row.created_at)
    }))
  }

  cancelTask(taskId: string): { accepted: boolean; status: TaskStatus | null } {
    const task = this.database.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id=?`).get(taskId) as TaskRow | undefined
    if (!task) return { accepted: false, status: null }
    if (!['queued','running','waiting_approval','blocked','interrupted'].includes(task.status)) return { accepted: false, status: task.status }
    const now = new Date().toISOString()
    this.database.prepare("UPDATE tasks SET status='cancelled', updated_at=?, summary='Cancelled by user.' WHERE id=?").run(now, taskId)
    this.database.prepare("UPDATE approvals SET status='expired', decided_at=? WHERE task_id=? AND status IN ('pending','approved')").run(now, taskId)
    this.appendEvent(taskId, 'status', 'Task cancelled', 'Cancellation accepted; any running worker must be terminated and reconciled by the runtime.')
    return { accepted: true, status: 'cancelled' }
  }

  writeCheckpoint(taskId: string, input: Omit<TaskCheckpoint, 'taskId' | 'createdAt' | 'schemaVersion'>, summary?: string): number {
    const task = this.database.prepare('SELECT checkpoint_version, status FROM tasks WHERE id=?').get(taskId) as { checkpoint_version: number; status: TaskStatus } | undefined
    if (!task) throw new Error('Task not found.')
    if (!TASK_STATUSES.includes(input.status)) throw new Error('Invalid task status.')
    const safetyEscalation = task.status === 'cancelled' && input.status === 'outcome_uncertain' && (input.operationInFlight || input.sideEffectState === 'possible')
    if (!isValidTaskTransition(task.status, input.status) && !safetyEscalation) throw new Error(`Invalid task status transition: ${task.status} -> ${input.status}.`)
    const version = nextCheckpointVersion(task.checkpoint_version)
    const createdAt = new Date().toISOString()
    const checkpoint: TaskCheckpoint = { schemaVersion: 1, taskId, createdAt, ...input }
    const safeJson = JSON.stringify(sanitizeJson(checkpoint))
    const digest = createHash('sha256').update(safeJson, 'utf8').digest('hex')
    const transaction = this.database.transaction(() => {
      this.database.prepare('INSERT INTO checkpoints(task_id, version, created_at, state_json, sha256) VALUES(?, ?, ?, ?, ?)')
        .run(taskId, version, createdAt, safeJson, digest)
      this.database.prepare('UPDATE tasks SET checkpoint_version=?, status=?, updated_at=?, summary=COALESCE(?,summary) WHERE id=?')
        .run(version, input.status, createdAt, summary === undefined ? null : redactSecrets(summary).value.slice(0, 2000), taskId)
      this.appendEvent(taskId, 'status', `Checkpoint ${version} saved`, `Task state '${input.status}' checkpointed atomically.`)
    })
    transaction()
    return version
  }

  getLatestCheckpoint(taskId: string): { version: number; state_json: string; sha256: string; created_at: string } | null {
    const row = this.database.prepare('SELECT version, state_json, sha256, created_at FROM checkpoints WHERE task_id=? ORDER BY version DESC LIMIT 1').get(taskId) as { version: number; state_json: string; sha256: string; created_at: string } | undefined
    if (!row) return null
    const computed = createHash('sha256').update(row.state_json, 'utf8').digest('hex')
    if (computed !== row.sha256) throw new Error('Checkpoint integrity failure: stored hash does not match checkpoint payload.')
    return row
  }

  createApproval(taskId: string, operation: ProposedOperation, ttlMs = 5 * 60 * 1000): ApprovalRecord {
    const preview = createApprovalPreview(operation)
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    const expiresAt = new Date(Date.now() + Math.min(Math.max(ttlMs, 1000), 15 * 60 * 1000)).toISOString()
    const transaction = this.database.transaction(() => {
      this.database.prepare(`INSERT INTO approvals(id, task_id, operation_sha256, summary_redacted, target_redacted, reason_redacted, expected_impact_redacted, rollback_info_redacted, action_details_redacted, status, created_at, expires_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
        .run(id, taskId, preview.operationHash, preview.summary, preview.target, preview.reason, preview.expectedImpact, preview.rollbackInfo, preview.actionDetails, createdAt, expiresAt)
      this.database.prepare("UPDATE tasks SET status='waiting_approval', updated_at=? WHERE id=?").run(createdAt, taskId)
      this.appendEvent(taskId, 'approval', 'Approval required', `${preview.summary} — target: ${preview.target}`)
    })
    transaction()
    return { id, taskId, ...preview, status: 'pending', createdAt, expiresAt }
  }

  decideApproval(requestId: string, decision: 'approve' | 'deny'): boolean {
    const row = this.database.prepare('SELECT status, expires_at, task_id FROM approvals WHERE id=?').get(requestId) as { status: ApprovalRecord['status']; expires_at: string; task_id: string } | undefined
    if (!row || !approvalCanBeDecided(row.status, row.expires_at)) {
      if (row?.status === 'pending') this.database.prepare("UPDATE approvals SET status='expired', decided_at=? WHERE id=?").run(new Date().toISOString(), requestId)
      return false
    }
    const nextStatus = decision === 'approve' ? 'approved' : 'denied'
    this.database.prepare('UPDATE approvals SET status=?, decided_at=? WHERE id=? AND status=\'pending\'').run(nextStatus, new Date().toISOString(), requestId)
    this.appendEvent(row.task_id, 'approval', decision === 'approve' ? 'Action approved' : 'Action denied', `Approval request ${requestId} was ${nextStatus}.`)
    return true
  }

  consumeApproval(requestId: string, currentOperation: ProposedOperation): boolean {
    const row = this.database.prepare('SELECT operation_sha256, status, expires_at, task_id FROM approvals WHERE id=?').get(requestId) as { operation_sha256: string; status: ApprovalRecord['status']; expires_at: string; task_id: string } | undefined
    if (!row) return false
    const disposition = evaluateApproval({ status: row.status, expiresAt: row.expires_at, storedOperationHash: row.operation_sha256, currentOperationHash: hashOperation(currentOperation) })
    if (disposition === 'expired' || disposition === 'mismatch') {
      this.database.prepare("UPDATE approvals SET status='expired', decided_at=? WHERE id=? AND status IN ('pending','approved')").run(new Date().toISOString(), requestId)
      if (disposition === 'mismatch') this.appendEvent(row.task_id, 'warning', 'Approval invalidated', 'Operation parameters changed after review; a new approval is required.')
      return false
    }
    if (disposition !== 'consume') return false
    const update = this.database.prepare("UPDATE approvals SET status='consumed', decided_at=? WHERE id=? AND status='approved'").run(new Date().toISOString(), requestId)
    return update.changes === 1
  }

  listEvents(taskId: string | null = null, limit = 200): RuntimeEvent[] {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 500)
    const rows = taskId
      ? this.database.prepare('SELECT id, task_id, at, kind, title, detail FROM runtime_events WHERE task_id=? ORDER BY at DESC, rowid DESC LIMIT ?').all(taskId, safeLimit) as Array<Record<string, unknown>>
      : this.database.prepare('SELECT id, task_id, at, kind, title, detail FROM runtime_events ORDER BY at DESC, rowid DESC LIMIT ?').all(safeLimit) as Array<Record<string, unknown>>
    return rows.map(row => ({ id: String(row.id), taskId: row.task_id ? String(row.task_id) : null, at: String(row.at), kind: row.kind as RuntimeEvent['kind'], title: String(row.title), detail: row.detail ? String(row.detail) : undefined }))
  }

  recordSystemEvent(kind: RuntimeEvent['kind'], title: string, detail?: string): void {
    this.appendEvent(null, kind, title, detail)
  }

  recordTaskEvent(taskId: string, kind: RuntimeEvent['kind'], title: string, detail?: string): void {
    if (!this.getTask(taskId)) throw new Error('Task event references an unknown task.')
    this.appendEvent(taskId, kind, title, detail)
  }

  private appendEvent(taskId: string | null, kind: RuntimeEvent['kind'], title: string, detail?: string): void {
    this.database.prepare('INSERT INTO runtime_events(id, task_id, at, kind, title, detail) VALUES(?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), taskId, new Date().toISOString(), kind, redactSecrets(title).value, detail ? redactSecrets(detail).value : null)
  }

  private toTaskSummary(row: TaskRow): TaskSummary {
    return {
      id: row.id, projectRoot: row.project_root, title: redactSecrets(row.title).value,
      mode: row.mode, status: row.status, createdAt: row.created_at,
      updatedAt: row.updated_at, checkpointVersion: row.checkpoint_version,
      summary: row.summary ? redactSecrets(row.summary).value : null
    }
  }
}
