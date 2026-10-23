import { spawn, spawnSync } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute } from 'node:path'
import { redactSecrets } from '../redaction.ts'

const ENV_KEYS = ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'PATHEXT'] as const

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
  for (const key of ENV_KEYS) if (process.env[key]) env[key] = process.env[key]
  return env
}

export interface PythonRuntime {
  executable: string
  version: string
}

export function resolvePythonRuntime(): PythonRuntime {
  const configured = process.env.RSL_PYTHON_EXECUTABLE
  if (configured && !isAbsolute(configured)) throw new Error('RSL_PYTHON_EXECUTABLE must be an absolute path.')
  const candidates = configured ? [configured] : process.platform === 'win32' ? ['python.exe', 'python'] : ['python3', 'python']
  const errors: string[] = []
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-I', '-c', 'import sys; print(sys.executable); print(".".join(map(str, sys.version_info[:3])))'], {
      cwd: tmpdir(),
      env: sanitizedEnvironment(),
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
      shell: false,
      maxBuffer: 8192
    })
    if (probe.error || probe.status !== 0) {
      errors.push(probe.error?.message ?? `candidate exited with status ${probe.status}`)
      continue
    }
    const [reportedPath, version] = probe.stdout.trim().split(/\r?\n/)
    if (!reportedPath || !isAbsolute(reportedPath) || !version) {
      errors.push('Python did not return an absolute interpreter path and version.')
      continue
    }
    const [major, minor] = version.split('.').map(Number)
    if (major < 3 || (major === 3 && minor < 10)) {
      errors.push(`Python ${version} is too old; RSL requires Python 3.10 or later.`)
      continue
    }
    const resolved = realpathSyncSafe(reportedPath)
    if (!resolved) {
      errors.push('The reported Python interpreter could not be resolved.')
      continue
    }
    return { executable: resolved, version }
  }
  throw new Error(`A usable Python 3.10+ runtime was not found. Install Python or configure RSL_PYTHON_EXECUTABLE. ${errors.join(' ')}`)
}

function realpathSyncSafe(path: string): string | null {
  try {
    const resolved = realpathSync(path)
    return statSync(resolved).isFile() ? resolved : null
  } catch { return null }
}

export interface ScriptResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface ScriptRunOptions {
  executable: string
  scriptPath: string
  args: string[]
  cwd: string
  timeoutMs?: number
  maxOutputBytes?: number
  signal?: AbortSignal
}

/** Executes a known, application-owned Python script without a shell or inherited secrets. */
export async function runTrustedPythonScript(options: ScriptRunOptions): Promise<ScriptResult> {
  if (!isAbsolute(options.executable) || !isAbsolute(options.scriptPath) || !isAbsolute(options.cwd)) {
    throw new Error('Python executable, script, and working directory must be absolute paths.')
  }
  const [executable, script, cwd] = await Promise.all([realpath(options.executable), realpath(options.scriptPath), realpath(options.cwd)])
  const [executableInfo, scriptInfo, cwdInfo] = await Promise.all([stat(executable), stat(script), stat(cwd)])
  if (!executableInfo.isFile() || !scriptInfo.isFile() || !cwdInfo.isDirectory()) throw new Error('Trusted Python script inputs are not valid files/directories.')
  if (options.signal?.aborted) throw new Error('Python script operation cancelled before start.')
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 30_000, 100), 120_000)
  const maxOutputBytes = Math.min(Math.max(options.maxOutputBytes ?? 1_000_000, 1024), 4_000_000)
  const child = spawn(executable, ['-I', script, ...options.args], {
    cwd,
    env: sanitizedEnvironment(),
    shell: false,
    windowsHide: true,
    stdio: 'pipe'
  })
  return await new Promise<ScriptResult>((resolvePromise, rejectPromise) => {
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
      options.signal?.removeEventListener('abort', onAbort)
      rejectPromise(error)
    }
    const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
    const onAbort = () => { aborted = true; child.kill() }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > maxOutputBytes) { child.kill(); finishError(new Error('Trusted Python script exceeded the output limit.')); return }
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => { if (Buffer.byteLength(stderr) < 16_384) stderr += chunk.toString('utf8') })
    child.once('error', error => finishError(new Error(`Could not start Python script: ${redactSecrets(error.message).value}`)))
    child.once('close', code => {
      if (settled) return
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      settled = true
      if (timedOut) { rejectPromise(new Error(`Python script timed out after ${timeoutMs} ms.`)); return }
      if (aborted || options.signal?.aborted) { rejectPromise(new Error('Python script operation was cancelled.')); return }
      resolvePromise({ code, stdout: redactSecrets(stdout).value, stderr: redactSecrets(stderr).value })
    })
    child.stdin.end()
  })
}
