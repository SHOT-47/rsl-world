import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export type WorkerOperation = 'ping' | 'hash_file' | 'inspect_file' | 'read_text_preview'

export interface WorkerRequest {
  protocolVersion: 1
  id: string
  operation: WorkerOperation
  workspaceRoot?: string
  path?: string
  maxBytes?: number
}

export interface WorkerResponse<T = unknown> {
  protocolVersion: 1
  id: string
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

interface QueueWaiter {
  resolve: (release: () => void) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  onAbort?: () => void
}

class ConcurrencyGate {
  private active = 0
  private readonly queue: QueueWaiter[] = []
  private readonly maxActive: number
  private readonly maxQueued: number

  constructor(maxActive: number, maxQueued: number) {
    this.maxActive = maxActive
    this.maxQueued = maxQueued
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error('Worker operation cancelled before start.'))
    if (this.active < this.maxActive) {
      this.active += 1
      return Promise.resolve(this.releaseFactory())
    }
    if (this.queue.length >= this.maxQueued) return Promise.reject(new Error('Python worker queue is full.'))
    return new Promise((resolvePromise, rejectPromise) => {
      const waiter: QueueWaiter = { resolve: resolvePromise, reject: rejectPromise, signal }
      if (signal) {
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter)
          if (index >= 0) this.queue.splice(index, 1)
          rejectPromise(new Error('Worker operation cancelled while waiting for capacity.'))
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.queue.push(waiter)
    })
  }

  private releaseFactory(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      while (this.queue.length > 0) {
        const next = this.queue.shift()!
        if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort)
        if (next.signal?.aborted) {
          next.reject(new Error('Worker operation cancelled while waiting for capacity.'))
          continue
        }
        next.resolve(this.releaseFactory())
        return
      }
      this.active = Math.max(0, this.active - 1)
    }
  }
}

export interface PythonWorkerOptions {
  pythonExecutable: string
  workerScriptPath: string
  isWorkspaceAllowed: (canonicalRoot: string) => boolean | Promise<boolean>
  maxConcurrent?: number
  maxQueued?: number
  defaultTimeoutMs?: number
  maxOutputBytes?: number
}

export class PythonWorkerRunner {
  private readonly gate: ConcurrencyGate
  private readonly timeoutMs: number
  private readonly maxOutputBytes: number
  private readonly active = new Map<string, ChildProcessWithoutNullStreams>()
  private readonly options: PythonWorkerOptions

  constructor(options: PythonWorkerOptions) {
    if (!isAbsolute(options.pythonExecutable) || !isAbsolute(options.workerScriptPath)) {
      throw new Error('Python interpreter and worker script must be absolute trusted paths.')
    }
    this.options = options
    this.timeoutMs = Math.min(Math.max(options.defaultTimeoutMs ?? 30_000, 100), 120_000)
    this.maxOutputBytes = Math.min(Math.max(options.maxOutputBytes ?? 1_000_000, 1024), 4_000_000)
    this.gate = new ConcurrencyGate(Math.min(Math.max(options.maxConcurrent ?? 2, 1), 8), Math.min(Math.max(options.maxQueued ?? 8, 0), 64))
  }

  async run(input: Omit<WorkerRequest, 'protocolVersion' | 'id'> & { id?: string }, signal?: AbortSignal): Promise<WorkerResponse> {
    const request: WorkerRequest = { ...input, protocolVersion: 1, id: input.id ?? randomUUID() } as WorkerRequest
    this.validateRequest(request)
    const release = await this.gate.acquire(signal)
    try {
      if (signal?.aborted) throw new Error('Worker operation cancelled before launch.')
      return await this.runOne(request, signal)
    } finally {
      release()
    }
  }

  async cancel(requestId: string): Promise<boolean> {
    const child = this.active.get(requestId)
    if (!child) return false
    child.kill()
    return true
  }

  private validateRequest(request: WorkerRequest): void {
    if (request.protocolVersion !== 1 || typeof request.id !== 'string' || request.id.length < 1 || request.id.length > 128) throw new Error('Invalid Python worker request envelope.')
    if (!['ping', 'hash_file', 'inspect_file', 'read_text_preview'].includes(request.operation)) throw new Error('Python worker operation is not allow-listed.')
    if (request.operation === 'ping') return
    if (!request.workspaceRoot || !isAbsolute(request.workspaceRoot)) throw new Error('Worker workspace root must be absolute.')
    if (!request.path || typeof request.path !== 'string' || isAbsolute(request.path)) throw new Error('Worker path must be workspace-relative.')
    if (request.operation === 'read_text_preview' && request.maxBytes !== undefined && (!Number.isInteger(request.maxBytes) || request.maxBytes < 1 || request.maxBytes > 32 * 1024)) throw new Error('Text preview maxBytes must be between 1 and 32768.')
  }

  private async runOne(request: WorkerRequest, signal?: AbortSignal): Promise<WorkerResponse> {
    const pythonPath = await realpath(this.options.pythonExecutable)
    const workerPath = await realpath(this.options.workerScriptPath)
    const [pythonInfo, workerInfo] = await Promise.all([stat(pythonPath), stat(workerPath)])
    if (!pythonInfo.isFile() || !workerInfo.isFile()) throw new Error('Configured Python runtime or worker script is not a regular file.')
    let workspaceRoot = request.workspaceRoot
    if (workspaceRoot) {
      workspaceRoot = await realpath(workspaceRoot)
      const allowed = await this.options.isWorkspaceAllowed(workspaceRoot)
      if (!allowed) throw new Error('Python worker rejected an unregistered workspace root.')
      const candidate = resolve(workspaceRoot, request.path ?? '.')
      const rel = relative(workspaceRoot, candidate)
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Python worker path escapes the selected workspace.')
    }

    const child = spawn(pythonPath, ['-I', workerPath], {
      shell: false,
      windowsHide: true,
      cwd: workspaceRoot,
      stdio: 'pipe',
      env: this.safeEnvironment()
    })
    this.active.set(request.id, child)

    return await new Promise<WorkerResponse>((resolvePromise, rejectPromise) => {
      let stdout = ''
      let stderr = ''
      let outputBytes = 0
      let timedOut = false
      let aborted = false
      let settled = false
      const finishError = (error: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.active.delete(request.id)
        rejectPromise(error)
      }
      const timer = setTimeout(() => {
        timedOut = true
        child.kill()
      }, this.timeoutMs)
      const onAbort = () => { aborted = true; child.kill() }
      signal?.addEventListener('abort', onAbort, { once: true })

      child.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length
        if (outputBytes > this.maxOutputBytes) {
          child.kill()
          finishError(new Error('Python worker exceeded the output limit.'))
          return
        }
        stdout += chunk.toString('utf8')
      })
      child.stderr.on('data', (chunk: Buffer) => {
        if (Buffer.byteLength(stderr) < 16_384) stderr += chunk.toString('utf8')
      })
      child.once('error', (error) => finishError(new Error(`Could not start the configured Python worker: ${error.message}`)))
      child.once('close', (code) => {
        if (settled) return
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.active.delete(request.id)
        settled = true
        if (timedOut) { rejectPromise(new Error(`Python worker timed out after ${this.timeoutMs} ms.`)); return }
        if (aborted || signal?.aborted) { rejectPromise(new Error('Python worker operation was cancelled.')); return }
        if (code !== 0) { rejectPromise(new Error(`Python worker exited with code ${code}; stderr: ${stderr.replace(/\s+/g, ' ').slice(0, 500)}`)); return }
        try {
          const response = JSON.parse(stdout.trim()) as WorkerResponse
          if (response.id !== request.id) throw new Error('Worker response ID did not match the request.')
          if (response.protocolVersion !== undefined && response.protocolVersion !== 1) throw new Error('Worker response protocol version mismatch.')
          resolvePromise({ protocolVersion: 1, ...response })
        } catch (error) {
          rejectPromise(new Error(`Invalid Python worker response: ${error instanceof Error ? error.message : 'parse failed'}`))
        }
      })
      child.stdin.on('error', (error) => { if (!settled) finishError(new Error(`Could not send work to Python worker: ${error.message}`)) })
      child.stdin.end(`${JSON.stringify(request)}\n`)
    })
  }

  private safeEnvironment(): NodeJS.ProcessEnv {
    const allowed = ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'PATHEXT']
    const env: NodeJS.ProcessEnv = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
    for (const key of allowed) if (process.env[key]) env[key] = process.env[key]
    return env
  }
}
