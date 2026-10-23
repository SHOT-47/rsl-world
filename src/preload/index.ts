import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type ApprovalResponseInput, type CancelTaskInput, type CreateTaskInput, type ProviderConfigInput, type WorkbenchApi, type RslHarnessId } from '@shared/contracts'

// This is an intentionally narrow capability API; never expose ipcRenderer itself or a generic invoke/send.
const api: WorkbenchApi = {
  getBootstrap: () => ipcRenderer.invoke(IPC.getBootstrap),
  chooseProjectRoot: () => ipcRenderer.invoke(IPC.chooseProjectRoot),
  listTasks: (projectRoot) => ipcRenderer.invoke(IPC.listTasks, projectRoot),
  createTask: (input: CreateTaskInput) => ipcRenderer.invoke(IPC.createTask, input),
  cancelTask: (input: CancelTaskInput) => ipcRenderer.invoke(IPC.cancelTask, input),
  resumeTask: (input: CancelTaskInput) => ipcRenderer.invoke(IPC.resumeTask, input),
  respondToApproval: (input: ApprovalResponseInput) => ipcRenderer.invoke(IPC.respondToApproval, input),
  listPendingApprovals: () => ipcRenderer.invoke(IPC.listPendingApprovals),
  validateRsl: () => ipcRenderer.invoke(IPC.validateRsl),
  validateCase: (projectRoot) => ipcRenderer.invoke(IPC.validateCase, projectRoot),
  initializeCase: (projectRoot) => ipcRenderer.invoke(IPC.initializeCase, projectRoot),
  exportRslSkill: (harness: RslHarnessId) => ipcRenderer.invoke(IPC.exportRslSkill, harness),
  listEvents: () => ipcRenderer.invoke(IPC.listEvents),
  inspectEvidenceFile: (projectRoot) => ipcRenderer.invoke(IPC.inspectEvidenceFile, projectRoot),
  listEvidence: (projectRoot) => ipcRenderer.invoke(IPC.listEvidence, projectRoot),
  listProviders: () => ipcRenderer.invoke(IPC.listProviders),
  saveProvider: (input: ProviderConfigInput) => ipcRenderer.invoke(IPC.saveProvider, input),
  deleteProvider: (providerId: string) => ipcRenderer.invoke(IPC.deleteProvider, providerId),
  setActiveProvider: (providerId: string | null) => ipcRenderer.invoke(IPC.setActiveProvider, providerId),
  testProvider: (providerId: string) => ipcRenderer.invoke(IPC.testProvider, providerId),
  onRuntimeEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]) => callback(payload)
    ipcRenderer.on(IPC.runtimeEvent, listener)
    return () => ipcRenderer.removeListener(IPC.runtimeEvent, listener)
  }
}

contextBridge.exposeInMainWorld('workbench', api)
