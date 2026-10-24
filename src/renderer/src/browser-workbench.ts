import type { WorkbenchApi, TaskSummary, ProviderSummary, RuntimeEvent } from '@shared/contracts'

/**
 * Browser-only compatibility adapter.
 *
 * The secure local runtime is not available in a normal browser: it depends on
 * Electron IPC, SQLite, OS credential storage, and a Python worker. This adapter
 * keeps the UI usable and persists non-secret demo metadata in localStorage, but
 * it deliberately does not pretend to execute coding tasks or access arbitrary
 * local files. Connect a separately deployed, authenticated backend to enable
 * those capabilities.
 */
const STORAGE = {
  tasks: 'rsl-web.tasks.v1',
  providers: 'rsl-web.providers.v1',
  events: 'rsl-web.events.v1'
}

function read<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key)
    return value ? JSON.parse(value) as T : fallback
  } catch {
    return fallback
  }
}

function write<T>(key: string, value: T): void {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage may be disabled */ }
}

function event(title: string, detail: string, kind: RuntimeEvent['kind'] = 'activity'): RuntimeEvent {
  const item: RuntimeEvent = { id: crypto.randomUUID(), taskId: null, at: new Date().toISOString(), kind, title, detail }
  write(STORAGE.events, [item, ...read<RuntimeEvent[]>(STORAGE.events, [])].slice(0, 100))
  return item
}

const fail = (message: string) => ({ ok: false as const, error: { code: 'NOT_IMPLEMENTED' as const, message } })
const browserLimit = 'This capability needs the secure local runtime or a deployed web backend. The browser preview does not execute local commands, inspect arbitrary folders, or run AI tasks.'
const providers = () => read<ProviderSummary[]>(STORAGE.providers, [])
const tasks = () => read<TaskSummary[]>(STORAGE.tasks, [])

export const browserWorkbench = {
  async getBootstrap() {
    return { ok: true as const, data: {
      appVersion: 'Web preview', platform: 'browser', rslVersion: '3.1',
      runtimeStatus: 'degraded' as const,
      limitations: ['Browser-only preview', 'No secure task-execution backend connected', 'Secrets are not stored by this preview']
    } }
  },
  async chooseProjectRoot() {
    const picker = (window as Window & { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker
    if (!picker) return { ok: true as const, data: { cancelled: true, path: null } }
    try {
      const directory = await picker()
      return { ok: true as const, data: { cancelled: false, path: directory.name } }
    } catch {
      return { ok: true as const, data: { cancelled: true, path: null } }
    }
  },
  async listTasks(projectRoot?: string) {
    const all = tasks()
    return { ok: true as const, data: projectRoot ? all.filter(item => item.projectRoot === projectRoot) : all }
  },
  async createTask(input: any) {
    const item: TaskSummary = {
      id: crypto.randomUUID(), projectRoot: input.projectRoot, title: input.title || 'Browser task',
      mode: input.mode, status: 'blocked', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      checkpointVersion: 0, summary: 'Not executed: connect a secure web backend to enable task execution.'
    }
    write(STORAGE.tasks, [item, ...tasks()].slice(0, 200))
    event('Task saved in browser', 'Execution was blocked because no web backend is connected.', 'warning')
    return { ok: true as const, data: item }
  },
  async cancelTask({ taskId }: { taskId: string }) {
    const next = tasks().map(item => item.id === taskId ? { ...item, status: 'cancelled' as const, updatedAt: new Date().toISOString() } : item)
    write(STORAGE.tasks, next)
    return { ok: true as const, data: { accepted: true } }
  },
  async resumeTask() { return fail(browserLimit) },
  async respondToApproval() { return fail(browserLimit) },
  async listPendingApprovals() { return { ok: true as const, data: [] } },
  async validateRsl() {
    return { ok: true as const, data: { available: false, version: '3.1', passed: null, summary: 'Validation requires the backend runtime.', details: [browserLimit] } }
  },
  async validateCase() { return fail(browserLimit) },
  async initializeCase() { return fail(browserLimit) },
  async exportRslSkill() { return fail(browserLimit) },
  async listEvents() { return { ok: true as const, data: read<RuntimeEvent[]>(STORAGE.events, []) } },
  async inspectEvidenceFile() { return fail('Browser file access is user-mediated and cannot securely inspect arbitrary project paths. Connect the backend to enable evidence inspection.') },
  async listEvidence() { return { ok: true as const, data: [] } },
  async listProviders() { return { ok: true as const, data: providers() } },
  async saveProvider(input: any) {
    if (input.apiKey?.trim()) return fail('For safety, this browser preview will not store API keys. Configure credentials on an authenticated backend.')
    const previous = providers()
    const id = input.id ?? crypto.randomUUID()
    const saved: ProviderSummary = {
      id, name: input.name, kind: input.kind, baseUrl: input.baseUrl, model: input.model,
      hasCredentials: false, createdAt: previous.find(p => p.id === id)?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(), active: previous.some(p => p.id === id && p.active)
    }
    write(STORAGE.providers, [saved, ...previous.filter(p => p.id !== id)])
    event('Provider metadata saved', 'No credentials were stored and no task execution is available in browser preview.')
    return { ok: true as const, data: saved }
  },
  async deleteProvider(providerId: string) {
    write(STORAGE.providers, providers().filter(p => p.id !== providerId))
    return { ok: true as const, data: { deleted: true } }
  },
  async setActiveProvider(providerId: string | null) {
    const next = providers().map(p => ({ ...p, active: p.id === providerId }))
    write(STORAGE.providers, next)
    return { ok: true as const, data: next.find(p => p.active) ?? null }
  },
  async testProvider() {
    return { ok: true as const, data: { ok: false, endpoint: '', latencyMs: 0, status: null, models: [], selectedModelAvailable: null, summary: 'Provider testing is disabled in browser preview.', details: [browserLimit] } }
  },
  onRuntimeEvent(callback: (item: RuntimeEvent) => void) {
    const handler = (event: StorageEvent) => {
      if (event.key !== STORAGE.events) return
      const items = read<RuntimeEvent[]>(STORAGE.events, [])
      if (items[0]) callback(items[0])
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }
} as unknown as WorkbenchApi
