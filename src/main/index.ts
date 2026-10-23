import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, session, Tray } from 'electron'
import { isAbsolute, join, relative, sep } from 'node:path'
import { realpath } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { IPC, fail, ok, type ApiResult, type BootstrapInfo, type CaseValidationResult, type EvidenceArtifact, type ProjectRootSelection, type RuntimeEvent, type RslExportResult, type RslHarnessId, type RslValidationResult, type CaseInitializationResult } from '@shared/contracts'
import { assertTrustedSender, buildContentSecurityPolicy, isAllowedRendererUrl } from './security'
import { TaskStore } from './task-store'
import { TaskService } from './task-service'
import { RslIntegration } from './rsl-integration'
import { PythonWorkerRunner } from './runtime/python-worker'
import { resolvePythonRuntime } from './runtime/python-runtime'
import { isWithinWorkspace } from './policy'
import { ProviderStore } from './providers/provider-store.ts'
import { testOpenAiCompatibleProvider } from './providers/openai-compatible.ts'
import { AgentRuntime } from './agent/runtime.ts'
import { buildPriorArtQuery } from './workflows/rsl-investigation.ts'
import { normalizeTargetApiScope } from './workflows/target-api.ts'

const currentDir = fileURLToPath(new URL('.', import.meta.url))
const isDev = !app.isPackaged
let mainWindow: BrowserWindow | null = null
let taskStore: TaskStore | null = null
let taskService: TaskService | null = null
let rslIntegration: RslIntegration | null = null
let pythonWorker: PythonWorkerRunner | null = null
let providerStore: ProviderStore | null = null
let agentRuntime: AgentRuntime | null = null
let tray: Tray | null = null
let closePromptOpen = false
let allowWindowClose = false
let shutdownInProgress = false
let shutdownReady = false

function rendererUrl(): string {
  return process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(join(currentDir, '../renderer/index.html')).toString()
}

function allowedUrl(url: string): boolean {
  return isAllowedRendererUrl(url, process.env.ELECTRON_RENDERER_URL)
}

function guardSender(event: Electron.IpcMainInvokeEvent): void {
  if (!mainWindow) throw new Error('Application window is not ready')
  assertTrustedSender(event, { expectedWebContentsId: mainWindow.webContents.id, isAllowedUrl: allowedUrl })
}

function runtimeService(): { store: TaskStore; service: TaskService } {
  if (!taskStore || !taskService) throw new Error('Local runtime is not initialized.')
  return { store: taskStore, service: taskService }
}

function providers(): ProviderStore {
  if (!providerStore || !taskStore) throw new Error('Provider storage is not initialized.')
  return providerStore
}

function rslService(): RslIntegration {
  if (!rslIntegration) throw new Error('Bundled RSL integration is not initialized.')
  return rslIntegration
}

function evidenceWorker(): PythonWorkerRunner {
  if (pythonWorker) return pythonWorker
  const python = resolvePythonRuntime()
  const workerScriptPath = app.isPackaged
    ? join(process.resourcesPath, 'workers', 'protocol.py')
    : join(app.getAppPath(), 'workers', 'protocol.py')
  pythonWorker = new PythonWorkerRunner({
    pythonExecutable: python.executable,
    workerScriptPath,
    isWorkspaceAllowed: async canonicalRoot => {
      const { store } = runtimeService()
      return store.hasProject(canonicalRoot)
    },
    maxConcurrent: 2,
    maxQueued: 8,
    defaultTimeoutMs: 30_000,
    maxOutputBytes: 1_000_000
  })
  return pythonWorker
}

function emitLatestEvent(taskId: string | null): void {
  if (!mainWindow || !taskStore) return
  const event: RuntimeEvent | undefined = taskStore.listEvents(taskId, 1)[0]
  if (event) mainWindow.webContents.send(IPC.runtimeEvent, event)
}

function safeFailure(code: 'INVALID_INPUT' | 'UNAUTHORIZED_SENDER' | 'NOT_IMPLEMENTED' | 'NOT_FOUND' | 'POLICY_DENIED' | 'INTERNAL', message: string) {
  return fail(code, message)
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC.getBootstrap, async (event): Promise<ApiResult<BootstrapInfo>> => {
    try {
      guardSender(event)
      const rslVersion = await rslService().version()
      return ok({
        appVersion: app.getVersion(),
        platform: process.platform,
        rslVersion,
        runtimeStatus: taskStore && taskService && rslVersion ? 'ready' : 'degraded',
        limitations: [
          'Coding tasks require an explicitly configured provider and use the bounded coding-agent tool set.',
          'RSL investigation currently provides deterministic capability detection, a consent-gated public awesome-reverse-engineered index lookup with local query matching, candidate acknowledgement, route selection and bundled evidence validation; specialist reverse-engineering execution is not yet integrated.',
          'Target API investigation currently performs only explicitly scoped, consent-gated unauthenticated GET requests; no writes, authentication, redirects or automatic crawling are performed.',
          'Command execution runs with the current Windows user privileges and is not an OS sandbox. Each command requires exact-action approval.',
          'Live MCP, commercial coding-agent conformance and Windows packaging still require product-level integration testing.'
        ]
      })
    } catch {
      return safeFailure('UNAUTHORIZED_SENDER', 'This request did not originate from the trusted application window.')
    }
  })

  ipcMain.handle(IPC.chooseProjectRoot, async (event): Promise<ApiResult<ProjectRootSelection>> => {
    try {
      guardSender(event)
      const result = await dialog.showOpenDialog(mainWindow!, {
        title: 'Choose a Workbench project folder',
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) return ok({ cancelled: true, path: null })
      const { service } = runtimeService()
      const registered = await service.registerProjectRoot(result.filePaths[0])
      emitLatestEvent(null)
      return ok({ cancelled: false, path: registered.root })
    } catch (error) {
      return safeFailure('INVALID_INPUT', error instanceof Error ? error.message : 'Could not register the selected project folder.')
    }
  })

  ipcMain.handle(IPC.listTasks, async (event, projectRoot?: unknown) => {
    try {
      guardSender(event)
      const { service } = runtimeService()
      return ok(await service.listTasks(projectRoot))
    } catch (error) {
      try { guardSender(event) } catch { return safeFailure('UNAUTHORIZED_SENDER', 'Untrusted renderer.') }
      return safeFailure('INVALID_INPUT', error instanceof Error ? error.message : 'Could not list tasks.')
    }
  })

  ipcMain.handle(IPC.createTask, async (event, input: unknown) => {
    try {
      guardSender(event)
      const { service, store } = runtimeService()
      const record = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
      const mode = record.mode
      let requestInput: unknown = input
      let availability = { ready: false, reason: 'No active model provider is configured. The task was saved without sending its prompt.' }
      if (mode === 'coding') {
        const activeProvider = providers().getActiveProvider()
        if (activeProvider) availability = { ready: true, reason: 'Queued for bounded coding execution with approval-gated tools.' }
      } else if (mode === 'rsl-investigation') {
        const projectRoot = typeof record.projectRoot === 'string' ? record.projectRoot : ''
        if (!isAbsolute(projectRoot) || !store.hasProject(await realpath(projectRoot))) throw new Error('Choose and register the project folder before starting an RSL investigation.')
        const title = typeof record.title === 'string' ? record.title : ''
        const query = buildPriorArtQuery(title)
        const confirmation = await dialog.showMessageBox(mainWindow!, {
          type: 'warning', title: 'Approve public RSL target-reuse index access?',
          message: 'RSL will match the target terms locally against the awesome-reverse-engineered index.',
          detail: `Local target terms (not transmitted):\n${query}\n\nPossible destination if the local cache is older than 24 hours: ${'https://awesome.alexgaoth.com/data.json'}\n\nWorkbench may fetch the public index over HTTPS (maximum 12 MiB; redirects are not followed) and cache it under the application data folder. The title-derived query, full prompt, project files, credentials and local paths are not sent to the index host. The index is filtered locally and the top candidates are shown for a separate review before triage. A failed search or zero matches is not evidence that prior art is absent.`,
          buttons: ['Approve index access', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true
        })
        if (confirmation.response !== 0) return safeFailure('POLICY_DENIED', 'RSL investigation cancelled before any public network request was sent.')
        requestInput = { ...record, workflowConfig: { priorArtSearchApproved: true } }
        availability = { ready: true, reason: 'Queued for capability detection, local query against the approved public awesome-reverse-engineered index, candidate acknowledgement, route selection and evidence validation.' }
      } else if (mode === 'target-api') {
        const rawConfig = record.workflowConfig && typeof record.workflowConfig === 'object' && !Array.isArray(record.workflowConfig) ? record.workflowConfig as Record<string, unknown> : {}
        const scope = normalizeTargetApiScope(rawConfig.targetApi)
        const confirmation = await dialog.showMessageBox(mainWindow!, {
          type: 'warning', title: 'Authorize read-only Target API investigation?',
          message: `Allow explicit GET requests to ${scope.baseUrl}?`,
          detail: `Exact paths:\n${scope.paths.length ? scope.paths.map(path => path || '(base path)').join('\n') : '(base path)'}\n\nMethod: GET only. Authentication, cookies and custom headers: none. Redirects: not followed. Crawling/discovered paths: not requested automatically. Response bodies are heuristically redacted before local persistence. The target origin must pass DNS/IP safety checks. HTTP is allowed only for loopback/local development targets. Confirm only if you are authorized to inspect this API.`,
          buttons: ['Authorize exact read-only scope', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true
        })
        if (confirmation.response !== 0) return safeFailure('POLICY_DENIED', 'Target API investigation cancelled before any target request was sent.')
        requestInput = { ...record, workflowConfig: { targetApi: { ...scope, authorizationConfirmed: true } } }
        availability = { ready: true, reason: 'Queued for explicitly authorized, bounded, unauthenticated GET requests with local redacted evidence capture.' }
      } else {
        availability = { ready: false, reason: mode === 'provider-diagnostics' ? 'Provider diagnostics use the dedicated Settings workflow. Task-mode diagnostics are not enabled.' : 'Unsupported task workflow; saved but blocked.' }
      }
      const task = await service.createTask(requestInput, availability)
      if (task.status === 'queued') {
        const started = agentRuntime?.launchTask(task.id) ?? false
        if (!started) store.recordTaskEvent(task.id, 'warning', 'Task not started', 'The runtime did not accept this task; it remains recoverable and was not sent to a model.')
      }
      emitLatestEvent(task.id)
      return ok(store.getTask(task.id) ?? task)
    } catch (error) {
      try { guardSender(event) } catch { return safeFailure('UNAUTHORIZED_SENDER', 'Untrusted renderer.') }
      return safeFailure('INVALID_INPUT', error instanceof Error ? error.message : 'Could not create task.')
    }
  })

  ipcMain.handle(IPC.cancelTask, (event, input: unknown) => {
    try {
      guardSender(event)
      const { service } = runtimeService()
      const result = service.cancelTask(input)
      if (result.accepted && input && typeof input === 'object' && 'taskId' in input && typeof input.taskId === 'string') {
        agentRuntime?.cancelTask(input.taskId)
        emitLatestEvent(input.taskId)
      }
      return ok({ accepted: result.accepted })
    } catch (error) {
      try { guardSender(event) } catch { return safeFailure('UNAUTHORIZED_SENDER', 'Untrusted renderer.') }
      return safeFailure('INVALID_INPUT', error instanceof Error ? error.message : 'Could not cancel task.')
    }
  })

  ipcMain.handle(IPC.resumeTask, (event, input: unknown) => {
    try {
      guardSender(event)
      const { service, store } = runtimeService()
      const raw = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
      const current = typeof raw.taskId === 'string' ? store.getTask(raw.taskId) : null
      if (!current) throw new Error('Task was not found.')
      if (current.mode !== 'coding') throw new Error('This task mode remains blocked pending its dedicated adapters and evidence gates.')
      const activeProvider = providers().getActiveProvider()
      if (!activeProvider) throw new Error('Choose and test an active model provider before resuming this task. No prompt was sent.')
      const task = service.resumeTask(input)
      const started = agentRuntime?.launchTask(task.id) ?? false
      if (!started) {
        store.recordTaskEvent(task.id, 'warning', 'Resume not started', 'The runtime declined to resume; inspect the latest status before retrying.')
      }
      emitLatestEvent(task.id)
      return ok(store.getTask(task.id) ?? task)
    } catch (error) {
      try { guardSender(event) } catch { return safeFailure('UNAUTHORIZED_SENDER', 'Untrusted renderer.') }
      return safeFailure('INVALID_INPUT', error instanceof Error ? error.message : 'Could not resume task.')
    }
  })

  ipcMain.handle(IPC.listPendingApprovals, (event) => {
    try { guardSender(event); return ok(runtimeService().store.listPendingApprovals()) }
    catch (error) {
      try { guardSender(event) } catch { return safeFailure('UNAUTHORIZED_SENDER', 'Untrusted renderer.') }
      return safeFailure('INTERNAL', error instanceof Error ? error.message : 'Could not list pending approvals.')
    }
  })

  ipcMain.handle(IPC.respondToApproval, (event, input: unknown) => {
    try {
      guardSender(event)
      const { service } = runtimeService()
      const result = service.respondToApproval(input)
      if (result.accepted && input && typeof input === 'object' && 'requestId' in input && typeof input.requestId === 'string') {
        agentRuntime?.resolveApproval(input.requestId, 'decision' in input && input.decision === 'approve')
        emitLatestEvent(null)
      }
      return ok(result)
    } catch (error) {
      try { guardSender(event) } catch { return safeFailure('UNAUTHORIZED_SENDER', 'Untrusted renderer.') }
      return safeFailure('INVALID_INPUT', error instanceof Error ? error.message : 'Could not record approval decision.')
    }
  })

  ipcMain.handle(IPC.validateRsl, async (event): Promise<ApiResult<RslValidationResult>> => {
    try {
      guardSender(event)
      return ok(await rslService().validatePackage())
    } catch (error) {
      try { guardSender(event) } catch { return safeFailure('UNAUTHORIZED_SENDER', 'Untrusted renderer.') }
      return ok({ available: false, version: null, passed: false, summary: error instanceof Error ? error.message : 'RSL package validation could not run.', details: [] })
    }
  })

  ipcMain.handle(IPC.validateCase, async (event, projectRootInput: unknown): Promise<ApiResult<CaseValidationResult>> => {
    try {
      guardSender(event)
      if (typeof projectRootInput !== 'string') throw new Error('Select a registered project before validating its case.')
      const { service } = runtimeService()
      await service.listTasks(projectRootInput)
      return ok(await rslService().validateCase(projectRootInput))
    } catch (error) {
      try { guardSender(event) } catch { return safeFailure('UNAUTHORIZED_SENDER', 'Untrusted renderer.') }
      return ok({ available: false, caseRoot: null, passed: false, summary: error instanceof Error ? error.message : 'Case validation could not run.', errors: [] })
    }
  })

  ipcMain.handle(IPC.initializeCase, async (event, projectRootInput: unknown): Promise<ApiResult<CaseInitializationResult>> => {
    try {
      guardSender(event)
      if (typeof projectRootInput !== 'string') throw new Error('Select a registered project before initializing a case.')
      const { service } = runtimeService()
      await service.listTasks(projectRootInput)
      const answer = await dialog.showMessageBox(mainWindow!, {
        type: 'question',
        title: 'Initialize an RSL case folder?',
        message: 'Create the empty case scaffold in the selected project?',
        detail: 'This writes only case/README.md. It does not invent capabilities, triage, evidence, or claims, and it does not run analysis.',
        buttons: ['Create case scaffold', 'Cancel'], defaultId: 0, cancelId: 1, noLink: true
      })
      if (answer.response !== 0) return ok({ created: false, caseRoot: null, summary: 'Case initialization cancelled; no files were changed.' })
      return ok(await rslService().initializeCase(projectRootInput))
    } catch (error) {
      try { guardSender(event) } catch { return safeFailure('UNAUTHORIZED_SENDER', 'Untrusted renderer.') }
      return ok({ created: false, caseRoot: null, summary: error instanceof Error ? error.message : 'Case initialization failed.' })
    }
  })

  ipcMain.handle(IPC.exportRslSkill, async (event, harnessInput: unknown): Promise<ApiResult<RslExportResult>> => {
    try {
      guardSender(event)
      const supported: RslHarnessId[] = ['claude-code', 'cursor', 'codex', 'gemini-cli', 'copilot', 'opencode', 'cline', 'windsurf', 'grok-build', 'generic']
      if (typeof harnessInput !== 'string' || !supported.includes(harnessInput as RslHarnessId)) throw new Error('Unsupported RSL harness profile.')
      const selection = await dialog.showOpenDialog(mainWindow!, {
        title: 'Choose the parent folder for RSL skill export',
        properties: ['openDirectory', 'createDirectory']
      })
      if (selection.canceled || selection.filePaths.length === 0) return ok({ exported: false, harness: harnessInput, destination: null, summary: 'Export cancelled; no files were changed.', details: [] })
      const destination = await realpath(selection.filePaths[0])
      const answer = await dialog.showMessageBox(mainWindow!, {
        type: 'warning',
        title: 'Review RSL skill export',
        message: `Export RSL skill profile '${harnessInput}' to this folder?`,
        detail: `${destination}\n\nThe exporter will create a new 'reverse-skill-library' subfolder. Existing exports are never overwritten. This is a copy of the skill specification only; it will not install or run the target coding agent.`,
        buttons: ['Export RSL skill', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true
      })
      if (answer.response !== 0) return ok({ exported: false, harness: harnessInput, destination, summary: 'Export cancelled; no files were changed.', details: [] })
      return ok(await rslService().exportSkill(harnessInput as RslHarnessId, destination))
    } catch (error) {
      try { guardSender(event) } catch { return safeFailure('UNAUTHORIZED_SENDER', 'Untrusted renderer.') }
      return ok({ exported: false, harness: typeof harnessInput === 'string' ? harnessInput : 'unknown', destination: null, summary: error instanceof Error ? error.message : 'RSL skill export failed.', details: [] })
    }
  })

  ipcMain.handle(IPC.listProviders, (event) => {
    try {
      guardSender(event)
      return ok(providers().listProviders())
    } catch (error) {
      try { guardSender(event) } catch { return safeFailure('UNAUTHORIZED_SENDER', 'Untrusted renderer.') }
      return safeFailure('INTERNAL', error instanceof Error ? error.message : 'Could not list providers.')
    }
  })

  ipcMain.handle(IPC.saveProvider, async (event, input: unknown) => {
    try {
      guardSender(event)
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Provider configuration must be an object.')
      const value = input as Record<string, unknown>
      if (value.kind === 'cloud') {
        if (typeof value.baseUrl !== 'string') throw new Error('Cloud provider base URL is required.')
        const destination = value.baseUrl.slice(0, 300)
        const approval = await dialog.showMessageBox(mainWindow!, {
          type: 'warning', title: 'Allow this cloud model endpoint?',
          message: 'Review the external provider destination before saving it.',
          detail: `${destination}

Provider diagnostics will send a request to this configured endpoint only when you explicitly run the connection test. Prompts are not sent by this action. Credentials are stored using OS-backed encryption.`,
          buttons: ['Allow and save provider', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true
        })
        if (approval.response !== 0) return fail('POLICY_DENIED', 'Provider save cancelled; no credentials or configuration were changed.')
      }
      const saved = providers().saveProvider(input)
      taskStore?.recordSystemEvent('activity', 'Model provider configuration saved', `${saved.name} (${saved.kind}) at ${saved.baseUrl}; credential values are never recorded.`)
      emitLatestEvent(null)
      return ok(saved)
    } catch (error) {
      try { guardSender(event) } catch { return safeFailure('UNAUTHORIZED_SENDER', 'Untrusted renderer.') }
      return safeFailure('INVALID_INPUT', error instanceof Error ? error.message : 'Provider configuration could not be saved.')
    }
  })

  ipcMain.handle(IPC.deleteProvider, async (event, providerId: unknown) => {
    try {
      guardSender(event)
      if (typeof providerId !== 'string') throw new Error('Provider ID is required.')
      const existing = providers().listProviders().find(provider => provider.id === providerId)
      if (!existing) return ok({ deleted: false })
      const answer = await dialog.showMessageBox(mainWindow!, {
        type: 'warning', title: 'Delete model provider?', message: `Delete '${existing.name}' configuration?`,
        detail: 'The encrypted credential will be deleted. This does not revoke a key with the provider; revoke it separately if needed.',
        buttons: ['Delete provider', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true
      })
      if (answer.response !== 0) return ok({ deleted: false })
      const deleted = providers().deleteProvider(providerId)
      taskStore?.recordSystemEvent('activity', 'Model provider deleted', `${existing.name}; encrypted local credential removed from the Workbench database.`)
      emitLatestEvent(null)
      return ok({ deleted })
    } catch (error) {
      try { guardSender(event) } catch { return safeFailure('UNAUTHORIZED_SENDER', 'Untrusted renderer.') }
      return safeFailure('INVALID_INPUT', error instanceof Error ? error.message : 'Provider could not be deleted.')
    }
  })

  ipcMain.handle(IPC.setActiveProvider, (event, providerId: unknown) => {
    try {
      guardSender(event)
      if (providerId !== null && typeof providerId !== 'string') throw new Error('Provider selection is invalid.')
      const selected = providers().setActiveProvider(providerId as string | null)
      taskStore?.recordSystemEvent('activity', selected ? 'Active model provider selected' : 'Active model provider cleared', selected ? `${selected.name} (${selected.kind}); model-routing selection only, no prompt was sent.` : 'No active model provider.')
      emitLatestEvent(null)
      return ok(selected)
    } catch (error) {
      try { guardSender(event) } catch { return safeFailure('UNAUTHORIZED_SENDER', 'Untrusted renderer.') }
      return safeFailure('INVALID_INPUT', error instanceof Error ? error.message : 'Provider selection failed.')
    }
  })

  ipcMain.handle(IPC.testProvider, async (event, providerId: unknown) => {
    try {
      guardSender(event)
      if (typeof providerId !== 'string') throw new Error('Provider ID is required.')
      const configured = providers().getProvider(providerId)
      if (!configured) throw new Error('Configured provider was not found.')
      const result = await testOpenAiCompatibleProvider({ name: configured.name, kind: configured.kind, baseUrl: configured.baseUrl, model: configured.model }, configured.apiKey)
      taskStore?.recordSystemEvent(result.ok ? 'activity' : 'warning', result.ok ? 'Provider diagnostics passed' : 'Provider diagnostics failed', `${configured.name}: ${result.summary} · ${result.latencyMs} ms. No prompt content was sent.`)
      emitLatestEvent(null)
      return ok(result)
    } catch (error) {
      try { guardSender(event) } catch { return safeFailure('UNAUTHORIZED_SENDER', 'Untrusted renderer.') }
      return safeFailure('INTERNAL', error instanceof Error ? error.message : 'Provider diagnostics failed.')
    }
  })

  ipcMain.handle(IPC.listEvents, (event): ApiResult<RuntimeEvent[]> => {
    try {
      guardSender(event)
      const { store } = runtimeService()
      return ok(store.listEvents(null, 250))
    } catch (error) {
      try { guardSender(event) } catch { return safeFailure('UNAUTHORIZED_SENDER', 'Untrusted renderer.') }
      return safeFailure('INTERNAL', error instanceof Error ? error.message : 'Could not read local activity.')
    }
  })

  ipcMain.handle(IPC.listEvidence, async (event, projectRootInput: unknown): Promise<ApiResult<EvidenceArtifact[]>> => {
    try {
      guardSender(event)
      if (typeof projectRootInput !== 'string') throw new Error('Select a registered project before listing evidence.')
      const { store, service } = runtimeService()
      await service.listTasks(projectRootInput)
      const root = await realpath(projectRootInput)
      return ok(store.listEvidenceArtifacts(root))
    } catch (error) {
      try { guardSender(event) } catch { return safeFailure('UNAUTHORIZED_SENDER', 'Untrusted renderer.') }
      return safeFailure('INVALID_INPUT', error instanceof Error ? error.message : 'Could not list evidence artifacts.')
    }
  })

  ipcMain.handle(IPC.inspectEvidenceFile, async (event, projectRootInput: unknown): Promise<ApiResult<EvidenceArtifact | null>> => {
    try {
      guardSender(event)
      if (typeof projectRootInput !== 'string' || !isAbsolute(projectRootInput)) throw new Error('Choose a project through the native folder picker first.')
      const { store, service } = runtimeService()
      await service.listTasks(projectRootInput)
      const root = await realpath(projectRootInput)
      const selection = await dialog.showOpenDialog(mainWindow!, {
        title: 'Select an evidence file inside the current project',
        defaultPath: root,
        properties: ['openFile']
      })
      if (selection.canceled || selection.filePaths.length === 0) return ok(null)
      const selected = await realpath(selection.filePaths[0])
      if (!isWithinWorkspace(selected, root)) throw new Error('Evidence inspection is limited to files inside the selected project folder.')
      const relPath = relative(root, selected).split(sep).join('/')
      const response = await evidenceWorker().run({ operation: 'inspect_file', workspaceRoot: root, path: relPath })
      if (!response.ok || !response.data || typeof response.data !== 'object') throw new Error(response.error?.message ?? 'Python worker failed to inspect the selected file.')
      const data = response.data as { relativePath: string; name: string; suffix: string; sizeBytes: number; modifiedAt: string; sha256: string; headerHex: string }
      const artifact = store.recordEvidenceArtifact({ projectRoot: root, relativePath: data.relativePath, name: data.name, suffix: data.suffix, sizeBytes: data.sizeBytes, modifiedAt: data.modifiedAt, sha256: data.sha256, headerHex: data.headerHex })
      emitLatestEvent(null)
      return ok(artifact)
    } catch (error) {
      try { guardSender(event) } catch { return safeFailure('UNAUTHORIZED_SENDER', 'Untrusted renderer.') }
      return safeFailure('INVALID_INPUT', error instanceof Error ? error.message : 'Evidence inspection failed.')
    }
  })
}

function installSecurityPolicies(win: BrowserWindow): void {
  const csp = buildContentSecurityPolicy(isDev)
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp]
      }
    })
  })

  win.webContents.on('will-navigate', (event, targetUrl) => {
    if (!allowedUrl(targetUrl)) event.preventDefault()
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())
}

function focusWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function ensureTray(): void {
  if (tray) return
  const trayPath = app.isPackaged
    ? join(process.resourcesPath, 'tray.png')
    : join(app.getAppPath(), 'resources', 'tray.png')
  const icon = nativeImage.createFromPath(trayPath)
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('RSL Workbench — tasks may be running')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open RSL Workbench', click: focusWindow },
    { type: 'separator' },
    { label: 'Quit Workbench…', click: () => app.quit() }
  ]))
  tray.on('click', focusWindow)
}


async function requestSafeQuit(): Promise<void> {
  if (shutdownReady || shutdownInProgress) return
  shutdownInProgress = true
  let safeToClose = false
  try {
    safeToClose = agentRuntime ? await agentRuntime.cancelAndWait(8_000) : true
    if (!safeToClose) {
      focusWindow()
      await dialog.showMessageBox(mainWindow ?? undefined, {
        type: 'error',
        title: 'Tasks are still stopping',
        message: 'Workbench could not confirm a safe shutdown yet.',
        detail: 'The window and local database will remain open so checkpoint writes are not interrupted. Inspect task status and try closing again.',
        buttons: ['Keep Workbench open'], defaultId: 0, noLink: true
      })
      return
    }
    taskStore?.cancelActiveTasks()
    allowWindowClose = true
    shutdownReady = true
    app.quit()
  } catch {
    focusWindow()
    await dialog.showMessageBox(mainWindow ?? undefined, {
      type: 'error', title: 'Shutdown deferred',
      message: 'Workbench could not verify that tasks stopped safely.',
      detail: 'The local database remains open. Inspect task status and try closing again.',
      buttons: ['Keep Workbench open'], defaultId: 0, noLink: true
    })
  } finally {
    shutdownInProgress = false
  }
}

async function handleWindowClose(event: Electron.Event): Promise<void> {
  if (allowWindowClose || !taskStore?.hasActiveTasks()) return
  event.preventDefault()
  if (closePromptOpen) return
  closePromptOpen = true
  try {
    const answer = await dialog.showMessageBox(mainWindow!, {
      type: 'warning',
      title: 'Work is still running',
      message: 'Choose what should happen to active Workbench tasks.',
      detail: 'Stopping tasks saves recoverable state. Continuing keeps the runtime open in the system tray. Cancel leaves this window open.',
      buttons: ['Stop tasks and quit', 'Continue in background', 'Cancel closing'],
      defaultId: 2,
      cancelId: 2,
      noLink: true
    })
    if (answer.response === 0) {
      await requestSafeQuit()
    } else if (answer.response === 1) {
      ensureTray()
      mainWindow?.hide()
    }
  } finally {
    closePromptOpen = false
  }
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#0b0d10',
    title: 'RSL Workbench',
    webPreferences: {
      preload: join(currentDir, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    }
  })

  installSecurityPolicies(mainWindow)
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', event => { void handleWindowClose(event) })
  mainWindow.on('closed', () => { mainWindow = null })
  await mainWindow.loadURL(rendererUrl())
}

app.whenReady().then(async () => {
  const databasePath = join(app.getPath('userData'), 'workbench.sqlite')
  const schemaPath = app.isPackaged
    ? join(process.resourcesPath, 'schema', '001_initial.sql')
    : join(app.getAppPath(), 'resources', 'schema', '001_initial.sql')
  const libraryRoot = app.isPackaged
    ? join(process.resourcesPath, 'reverse-skill-library')
    : join(app.getAppPath(), 'resources', 'reverse-skill-library')
  taskStore = new TaskStore(databasePath, schemaPath)
  taskService = new TaskService(taskStore)
  providerStore = new ProviderStore(taskStore.database, {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encryptString: value => safeStorage.encryptString(value),
    decryptString: value => safeStorage.decryptString(Buffer.from(value))
  })
  rslIntegration = new RslIntegration(libraryRoot)
  const routeScriptPath = app.isPackaged
    ? join(process.resourcesPath, 'workers', 'route_rsl.py')
    : join(app.getAppPath(), 'workers', 'route_rsl.py')
  const priorArtCachePath = join(app.getPath('userData'), 'cache', 'awesome-reverse-engineered.json')
  agentRuntime = new AgentRuntime({ store: taskStore, providers: providerStore, rslRoot: libraryRoot, routeScriptPath, priorArtCachePath, onEvent: emitLatestEvent })
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  registerIpcHandlers()
  await createWindow()
  app.on('activate', async () => { if (BrowserWindow.getAllWindows().length === 0) await createWindow() })
}).catch((error: unknown) => {
  console.error('Startup failed:', error instanceof Error ? error.message : 'unknown error')
  app.quit()
})

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, targetUrl) => {
    if (!allowedUrl(targetUrl)) event.preventDefault()
  })
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
})

app.on('before-quit', event => {
  if (!shutdownReady) {
    event.preventDefault()
    void requestSafeQuit()
    return
  }
  try { taskStore?.close() } catch { /* SQLite WAL is recoverable; retain shutdown progress */ }
})

app.on('window-all-closed', () => {
  // A hidden window is kept alive while background work continues, so this fires only after real closure.
  if (process.platform !== 'darwin' && !closePromptOpen) app.quit()
})
