import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { boundedText } from './redaction.ts'
import type { TaskStore } from './task-store.ts'
import type { CreateTaskInput, TaskSummary, TaskWorkflowConfig } from '@shared/contracts'
import { normalizeTargetApiScope } from './workflows/target-api.ts'

const MODES = new Set<CreateTaskInput['mode']>(['coding', 'rsl-investigation', 'target-api', 'provider-diagnostics'])
function sanitizedMode(value: unknown): CreateTaskInput['mode'] | null { return typeof value === 'string' && MODES.has(value as CreateTaskInput['mode']) ? value as CreateTaskInput['mode'] : null }
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class TaskService {
  private readonly store: TaskStore

  constructor(store: TaskStore) { this.store = store }

  async registerProjectRoot(input: unknown): Promise<{ root: string; displayName: string; rslVersionPin: string }> {
    const rawPath = boundedText(input, 2048, 'projectRoot')
    if (!isAbsolute(rawPath)) throw new Error('Project root must be an absolute path selected through the native folder picker.')
    const canonical = await realpath(rawPath)
    const info = await stat(canonical)
    if (!info.isDirectory()) throw new Error('Selected project root is not a directory.')
    return this.store.registerProject(canonical)
  }

  async listTasks(projectRoot?: unknown): Promise<TaskSummary[]> {
    if (projectRoot === undefined || projectRoot === null || projectRoot === '') return this.store.listTasks()
    const rawPath = boundedText(projectRoot, 2048, 'projectRoot')
    if (!isAbsolute(rawPath)) throw new Error('Project root must be absolute.')
    const canonical = await realpath(rawPath)
    if (!this.store.hasProject(canonical)) throw new Error('Project root is not registered in this Workbench.')
    return this.store.listTasks(canonical)
  }

  async createTask(input: unknown, availability: { ready: boolean; reason?: string } = { ready: false, reason: 'Task saved safely, but no model provider/runtime route is configured. No prompt was sent.' }): Promise<TaskSummary> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Task request must be an object.')
    const raw = input as Record<string, unknown>
    const projectRoot = boundedText(raw.projectRoot, 2048, 'projectRoot')
    if (!isAbsolute(projectRoot)) throw new Error('Project root must be absolute.')
    const canonical = await realpath(projectRoot)
    if (!this.store.hasProject(canonical)) throw new Error('Choose and register the project folder using the native folder picker first.')
    const title = boundedText(raw.title, 120, 'title')
    const prompt = boundedText(raw.prompt, 30000, 'prompt')
    if (typeof raw.mode !== 'string' || !MODES.has(raw.mode as CreateTaskInput['mode'])) throw new Error('Unsupported task mode.')
    let workflowConfig: TaskWorkflowConfig = {}
    if (raw.workflowConfig !== undefined) {
      if (!raw.workflowConfig || typeof raw.workflowConfig !== 'object' || Array.isArray(raw.workflowConfig)) throw new Error('Workflow configuration must be an object.')
      const config = raw.workflowConfig as Record<string, unknown>
      const mode = sanitizedMode(raw.mode)
      if (mode === 'target-api') {
        workflowConfig = { targetApi: normalizeTargetApiScope(config.targetApi) }
      } else if (mode === 'rsl-investigation') {
        if (config.priorArtSearchApproved !== true) throw new Error('RSL investigation requires explicit main-process approval of the exact public prior-art search query.')
        workflowConfig = { priorArtSearchApproved: true }
      } else if (Object.keys(config).length > 0) {
        throw new Error('Workflow configuration is not supported for this task mode.')
      }
    }
    const sanitized: CreateTaskInput = { projectRoot: canonical, title, prompt, mode: raw.mode as CreateTaskInput['mode'], workflowConfig }
    const effectiveAvailability = sanitized.mode === 'coding' ? availability : sanitized.mode === 'rsl-investigation' && workflowConfig.priorArtSearchApproved === true ? {
      ready: true, reason: 'Queued for capability detection, approved prior-art search, evidence capture and deterministic RSL routing.'
    } : sanitized.mode === 'target-api' && workflowConfig.targetApi?.authorizationConfirmed === true ? {
      ready: true, reason: 'Queued for explicitly authorized, bounded, read-only target API requests. No credentials or writes will be sent.'
    } : {
      ready: false,
      reason: sanitized.mode === 'provider-diagnostics'
        ? 'Provider diagnostics use the dedicated Settings workflow. Task-mode diagnostics are not enabled.'
        : `The '${sanitized.mode}' workflow lacks the required explicit scope/approval; no target was contacted.`
    }
    return this.store.createTask(sanitized, effectiveAvailability)
  }

  resumeTask(input: unknown): TaskSummary {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Resume request must be an object.')
    const taskId = (input as Record<string, unknown>).taskId
    if (typeof taskId !== 'string' || !UUID_PATTERN.test(taskId)) throw new Error('Invalid task identifier.')
    return this.store.prepareTaskForResume(taskId)
  }

  cancelTask(input: unknown): { accepted: boolean; status: string | null } {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Cancel request must be an object.')
    const taskId = (input as Record<string, unknown>).taskId
    if (typeof taskId !== 'string' || !UUID_PATTERN.test(taskId)) throw new Error('Invalid task identifier.')
    return this.store.cancelTask(taskId)
  }

  respondToApproval(input: unknown): { accepted: boolean } {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Approval response must be an object.')
    const raw = input as Record<string, unknown>
    if (typeof raw.requestId !== 'string' || !UUID_PATTERN.test(raw.requestId)) throw new Error('Invalid approval identifier.')
    if (raw.decision !== 'approve' && raw.decision !== 'deny') throw new Error('Decision must be approve or deny')
    return { accepted: this.store.decideApproval(raw.requestId, raw.decision) }
  }
}
