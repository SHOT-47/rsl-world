import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, lstat, mkdir, open, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep, basename } from 'node:path'
import { redactSecrets } from '../redaction.ts'
import { classifyOperation, isWithinWorkspace, type ProposedOperation } from '../policy.ts'
import type { ChatToolDefinition } from '../providers/chat-completions.ts'

const MAX_READ_BYTES = 256 * 1024
const MAX_WRITE_BYTES = 200 * 1024
const MAX_COMMAND_OUTPUT = 300 * 1024
const MAX_SEARCH_FILES = 350
const MAX_SEARCH_MATCHES = 40
const MAX_LIST_ENTRIES = 250
const SKIP_DIRS = new Set(['.git', 'node_modules', 'out', 'release', 'dist', 'build', '.next', '.cache', '.venv', 'venv', '__pycache__', '.rsl-workbench'])
const BLOCKED_COMMANDS = new Set(['cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'sh', 'bash', 'zsh', 'fish', 'wscript', 'wscript.exe', 'cscript', 'cscript.exe', 'mshta', 'mshta.exe', 'rundll32', 'rundll32.exe', 'regsvr32', 'regsvr32.exe', 'osascript'])

export const CODING_TOOLS: ChatToolDefinition[] = [
  { type: 'function', function: { name: 'list_files', description: 'List relative file paths in the project. Read-only and bounded; does not follow symlinks or descend into dependency/build folders.', parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', description: 'Relative directory path; use . for project root.' }, recursive: { type: 'boolean', description: 'Whether to list nested directories, with a strict entry cap.' } }, required: ['path', 'recursive'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a small text file inside the project. Likely secrets are redacted before returning content to the model.', parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'search_text', description: 'Literal case-insensitive text search across bounded project text files. Does not use shell or network.', parameters: { type: 'object', additionalProperties: false, properties: { query: { type: 'string', minLength: 1, maxLength: 300 }, path: { type: 'string', description: 'Optional relative directory; default project root.' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Create or replace a project file. Every write requires an exact-action approval showing path, content hash, impact and rollback guidance.', parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, content: { type: 'string', maxLength: MAX_WRITE_BYTES } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'run_command', description: 'Run one executable with an argv array, no shell, in the project root. Every command requires exact-action approval and has a hard output/time limit. Shell interpreters and script wrappers are blocked.', parameters: { type: 'object', additionalProperties: false, properties: { executable: { type: 'string', minLength: 1, maxLength: 300 }, args: { type: 'array', items: { type: 'string', maxLength: 4000 }, maxItems: 64 } }, required: ['executable', 'args'] } } }
]

export interface ToolBrokerOptions {
  taskId: string
  workspaceRoot: string
  requestApproval: (operation: ProposedOperation, signal: AbortSignal) => Promise<boolean>
  onActivity: (title: string, detail: string) => void
  onBeforeSideEffect: (detail: string) => void | Promise<void>
  onAfterSideEffect: (disposition: 'known_complete' | 'known_not_started' | 'possible', detail: string) => void | Promise<void>
  signal: AbortSignal
  commandTimeoutMs?: number
}

export interface ToolResult { ok: boolean; output: unknown; error?: string }

function parseObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Tool arguments must be a JSON object.')
  return input as Record<string, unknown>
}
function stringArg(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${name} must be a string of at most ${max} characters.`)
  return value
}
function normalizeRelativePath(input: string, allowDot = false): string {
  const value = input.trim()
  if (allowDot && (value === '' || value === '.')) return '.'
  if (!value || value.length > 1024 || isAbsolute(value) || value.startsWith('\\') || value.includes('\0')) throw new Error('Path must be a non-empty workspace-relative path.')
  const parts = value.replace(/\\/g, '/').split('/')
  if (parts.some(part => part === '..' || part === '.' || part === '')) throw new Error('Path traversal and non-normalized path segments are denied.')
  const normalized = parts.join(sep)
  return normalized
}
function isSensitivePath(path: string): boolean {
  const lower = path.replace(/\\/g, '/').toLowerCase()
  const name = lower.split('/').at(-1) ?? lower
  return name === '.env' || /^\.env\.(?!example$|sample$|template$)/i.test(name) || name === '.npmrc' || name === '.pypirc' || name === 'credentials' || name === 'id_rsa' || name === 'id_ed25519' || /\.(pem|key|p12|pfx|keystore|secret)$/.test(name) || lower.includes('/.ssh/') || lower.includes('/.aws/')
}
function isTextBuffer(buffer: Buffer): boolean { return !buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0) }
function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }
function errorText(error: unknown): string { return redactSecrets(error instanceof Error ? error.message : 'Unknown tool error.').value.slice(0, 600) }

export class ToolBroker {
  private readonly options: ToolBrokerOptions
  private workspaceRoot = ''
  constructor(options: ToolBrokerOptions) { this.options = options }

  async initialize(): Promise<void> {
    this.workspaceRoot = await realpath(this.options.workspaceRoot)
    const info = await stat(this.workspaceRoot)
    if (!info.isDirectory()) throw new Error('Tool workspace must be a directory.')
  }

  async execute(name: string, rawArguments: unknown): Promise<ToolResult> {
    try {
      if (this.options.signal.aborted) throw new Error('Task was cancelled.')
      const args = parseObject(rawArguments)
      switch (name) {
        case 'list_files': return { ok: true, output: await this.listFiles(args) }
        case 'read_file': return { ok: true, output: await this.readFile(args) }
        case 'search_text': return { ok: true, output: await this.searchText(args) }
        case 'write_file': return { ok: true, output: await this.writeFile(args) }
        case 'run_command': return { ok: true, output: await this.runCommand(args) }
        default: throw new Error(`Tool '${name}' is not allow-listed.`)
      }
    } catch (error) {
      const message = errorText(error)
      this.options.onActivity(`Tool ${name} failed`, message)
      return { ok: false, output: null, error: message }
    }
  }

  private async resolveDirectory(relativeInput: string): Promise<{ path: string; relativePath: string }> {
    const rel = normalizeRelativePath(relativeInput, true)
    const candidate = rel === '.' ? this.workspaceRoot : resolve(this.workspaceRoot, rel)
    const linkInfo = await lstat(candidate)
    if (linkInfo.isSymbolicLink()) throw new Error('Directory traversal through symlinked paths is denied.')
    const canonical = await realpath(candidate)
    if (!isWithinWorkspace(canonical, this.workspaceRoot)) throw new Error('Requested path escapes the registered project workspace.')
    const info = await stat(canonical)
    if (!info.isDirectory()) throw new Error('Requested path is not a directory.')
    return { path: canonical, relativePath: rel }
  }

  private async resolveFile(relativeInput: string): Promise<{ path: string; relativePath: string; info: Awaited<ReturnType<typeof stat>> }> {
    const rel = normalizeRelativePath(relativeInput)
    if (isSensitivePath(rel)) throw new Error('Reading likely credential/private-key files through the model tool is blocked. Use a scoped credential reference instead.')
    const candidate = resolve(this.workspaceRoot, rel)
    const canonical = await realpath(candidate)
    if (!isWithinWorkspace(canonical, this.workspaceRoot)) throw new Error('Requested file escapes the registered project workspace.')
    const linkInfo = await lstat(candidate)
    if (linkInfo.isSymbolicLink()) throw new Error('Direct access through symlinked files is denied; use a normal workspace file path.')
    const info = await stat(canonical)
    if (!info.isFile()) throw new Error('Requested path is not a regular file.')
    if (info.size > MAX_READ_BYTES) throw new Error(`File exceeds the ${MAX_READ_BYTES} byte read limit.`)
    return { path: canonical, relativePath: rel.replace(/\\/g, '/'), info }
  }

  private async listFiles(args: Record<string, unknown>): Promise<unknown> {
    const pathInput = args.path === undefined ? '.' : stringArg(args.path, 'path', 1024)
    const recursive = args.recursive === true
    const start = await this.resolveDirectory(pathInput)
    const found: Array<{ path: string; type: 'file' | 'directory' | 'symlink' }> = []
    const queue: Array<{ absolute: string; rel: string; depth: number }> = [{ absolute: start.path, rel: start.relativePath === '.' ? '' : start.relativePath, depth: 0 }]
    while (queue.length && found.length < MAX_LIST_ENTRIES) {
      if (this.options.signal.aborted) throw new Error('Task was cancelled.')
      const current = queue.shift()!
      const entries = await readdir(current.absolute, { withFileTypes: true })
      for (const entry of entries) {
        if (found.length >= MAX_LIST_ENTRIES) break
        if (entry.name.startsWith('.') && ['.git', '.env', '.ssh', '.aws'].includes(entry.name.toLowerCase())) continue
        const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name
        if (entry.isSymbolicLink()) { found.push({ path: rel, type: 'symlink' }); continue }
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) {
            found.push({ path: rel, type: 'directory' })
            if (recursive && current.depth < 8) queue.push({ absolute: join(current.absolute, entry.name), rel, depth: current.depth + 1 })
          }
        } else if (entry.isFile()) found.push({ path: rel, type: 'file' })
      }
    }
    return { root: start.relativePath, entries: found, truncated: queue.length > 0 || found.length >= MAX_LIST_ENTRIES }
  }

  private async readFile(args: Record<string, unknown>): Promise<unknown> {
    const rel = stringArg(args.path, 'path', 1024)
    const target = await this.resolveFile(rel)
    const buffer = await readFile(target.path)
    if (!isTextBuffer(buffer)) throw new Error('Binary files are not sent to the model; use evidence inspection/hash tooling instead.')
    const raw = buffer.toString('utf8')
    const redacted = redactSecrets(raw)
    this.options.onActivity('File read', `${target.relativePath} · ${buffer.length} bytes · SHA-256 ${sha256(buffer)}${redacted.changed ? ' · likely secrets redacted before model context' : ''}`)
    return { path: target.relativePath, bytes: buffer.length, sha256: sha256(buffer), content: redacted.value, secretsRedacted: redacted.changed }
  }

  private async searchText(args: Record<string, unknown>): Promise<unknown> {
    const query = stringArg(args.query, 'query', 300).trim().toLowerCase()
    if (!query) throw new Error('Search query must not be empty.')
    const pathInput = args.path === undefined ? '.' : stringArg(args.path, 'path', 1024)
    const start = await this.resolveDirectory(pathInput)
    const queue: Array<{ absolute: string; rel: string }> = [{ absolute: start.path, rel: start.relativePath === '.' ? '' : start.relativePath }]
    const matches: Array<{ path: string; line: number; snippet: string }> = []
    let scanned = 0
    let capped = false
    while (queue.length && scanned < MAX_SEARCH_FILES && matches.length < MAX_SEARCH_MATCHES) {
      if (this.options.signal.aborted) throw new Error('Task was cancelled.')
      const current = queue.shift()!
      const entries = await readdir(current.absolute, { withFileTypes: true })
      for (const entry of entries) {
        if (scanned >= MAX_SEARCH_FILES || matches.length >= MAX_SEARCH_MATCHES) { capped = true; break }
        if (entry.isSymbolicLink()) continue
        const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name
        if (entry.isDirectory()) { if (!entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) queue.push({ absolute: join(current.absolute, entry.name), rel }) }
        else if (entry.isFile() && !isSensitivePath(rel) && extname(entry.name).toLowerCase() !== '.png' && extname(entry.name).toLowerCase() !== '.jpg' && extname(entry.name).toLowerCase() !== '.pdf') {
          scanned += 1
          const info = await stat(join(current.absolute, entry.name))
          if (info.size > MAX_READ_BYTES) continue
          const buffer = await readFile(join(current.absolute, entry.name))
          if (!isTextBuffer(buffer)) continue
          const lines = buffer.toString('utf8').split(/\r?\n/)
          for (let i = 0; i < lines.length && matches.length < MAX_SEARCH_MATCHES; i++) {
            const line = lines[i]
            if (line?.toLowerCase().includes(query)) matches.push({ path: rel, line: i + 1, snippet: redactSecrets(line.slice(0, 500)).value })
          }
        }
      }
    }
    return { query, scannedFiles: scanned, matches, truncated: capped || queue.length > 0 }
  }

  private async writeFile(args: Record<string, unknown>): Promise<unknown> {
    const rel = normalizeRelativePath(stringArg(args.path, 'path', 1024))
    if (isSensitivePath(rel)) throw new Error('Writing likely credential/private-key files through the agent is blocked by default.')
    const content = stringArg(args.content, 'content', MAX_WRITE_BYTES)
    if (redactSecrets(content).changed) throw new Error('Potential secret values were detected in proposed file content. Replace them with environment/credential references; no file was written.')
    const bytes = Buffer.from(content, 'utf8')
    const target = resolve(this.workspaceRoot, rel)
    if (!isWithinWorkspace(target, this.workspaceRoot)) throw new Error('Write path escapes the project workspace.')
    const parentPath = await realpath(dirname(target))
    if (!isWithinWorkspace(parentPath, this.workspaceRoot)) throw new Error('Write parent directory escapes the project workspace.')
    const parentInfo = await stat(parentPath)
    if (!parentInfo.isDirectory()) throw new Error('Write parent must be an existing directory.')

    let previousHash: string | null = null
    let previousMode: number | null = null
    try {
      const linkInfo = await lstat(target)
      if (linkInfo.isSymbolicLink()) throw new Error('Writing a symlink is blocked.')
      const canonical = await realpath(target)
      if (!isWithinWorkspace(canonical, this.workspaceRoot)) throw new Error('Existing file escapes the project workspace.')
      const previousInfo = await stat(canonical)
      if (!previousInfo.isFile()) throw new Error('Write target already exists and is not a regular file.')
      const oldBytes = await readFile(canonical)
      previousHash = sha256(oldBytes)
      previousMode = previousInfo.mode & 0o777
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    const operation: ProposedOperation = {
      id: randomUUID(), kind: 'write_file', summary: `${previousHash ? 'Replace' : 'Create'} project file '${rel}'`, target,
      projectRoot: this.workspaceRoot,
      parameters: { path: rel, contentSha256: sha256(bytes), previousSha256: previousHash, byteLength: bytes.length, contentPreview: content },
      expectedImpact: `${previousHash ? 'Replace existing file content' : 'Create a new file'} with ${bytes.length} bytes after explicit approval.`,
      rollbackInfo: 'No automatic backup is made because source files can contain secrets. Use Git restore or manually restore the prior content if necessary.'
    }
    const policy = classifyOperation(operation)
    if (policy.decision === 'deny') throw new Error(policy.reason)
    if (policy.decision === 'require_approval') {
      this.options.onActivity('Approval requested', `${operation.summary} · target ${rel} · ${policy.reason}`)
      const approved = await this.options.requestApproval(operation, this.options.signal)
      if (!approved) throw new Error('Write denied or approval expired; no file was changed.')
    }
    if (this.options.signal.aborted) throw new Error('Task was cancelled before the write.')

    // Re-check identity immediately before write to prevent approval/use drift.
    const parentNow = await realpath(dirname(target))
    if (parentNow !== parentPath || !isWithinWorkspace(parentNow, this.workspaceRoot)) throw new Error('Write parent changed after approval; a new review is required.')
    let currentHash: string | null = null
    try {
      const linkInfo = await lstat(target)
      if (linkInfo.isSymbolicLink()) throw new Error('Write target became a symlink after approval.')
      const canonical = await realpath(target)
      if (!isWithinWorkspace(canonical, this.workspaceRoot)) throw new Error('Write target escaped after approval.')
      currentHash = sha256(await readFile(canonical))
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (currentHash !== previousHash) throw new Error('Write target changed after approval; the reviewed operation is stale and was not applied.')

    await this.options.onBeforeSideEffect(`Write '${rel}'`)
    const temp = join(parentPath, `.rsl-wb-${this.options.taskId}-${randomUUID()}.tmp`)
    let renamed = false
    try {
      const file = await open(temp, 'wx', previousMode ?? 0o600)
      try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
      await rename(temp, target)
      renamed = true
    } catch (error) {
      const { unlink } = await import('node:fs/promises')
      await unlink(temp).catch(() => undefined)
      await this.options.onAfterSideEffect(renamed ? 'possible' : 'known_not_started', `Write '${rel}' failed before a confirmed atomic replacement.`)
      throw error
    }
    await this.options.onAfterSideEffect('known_complete', `Atomic file write completed: '${rel}'.`)
    this.options.onActivity('File written', `${rel} · ${bytes.length} bytes · SHA-256 ${sha256(bytes)}`)
    return { path: rel, bytes: bytes.length, sha256: sha256(bytes), previousSha256: previousHash, approved: policy.decision === 'require_approval' }
  }

  private async findExecutable(input: string): Promise<string> {
    const raw = input.trim()
    if (!raw || raw.length > 300 || raw.includes('\0')) throw new Error('Executable name is invalid.')
    const rawBase = basename(raw).toLowerCase()
    if (BLOCKED_COMMANDS.has(rawBase)) throw new Error('Shell interpreters and command wrappers are blocked. Supply an executable and argv array directly.')
    const hasPath = raw.includes('/') || raw.includes('\\') || isAbsolute(raw)
    const candidates: string[] = []
    if (hasPath) {
      candidates.push(isAbsolute(raw) ? raw : resolve(this.workspaceRoot, raw))
    } else {
      const envPath = process.env.PATH ?? process.env.Path ?? ''
      for (const directory of envPath.split(delimiter).filter(Boolean)) {
        if (process.platform === 'win32') candidates.push(join(directory, `${raw}.exe`), join(directory, `${raw}.com`))
        else candidates.push(join(directory, raw))
      }
    }
    for (const candidate of candidates) {
      try {
        const canonical = await realpath(candidate)
        const info = await stat(canonical)
        if (!info.isFile()) continue
        const extension = extname(canonical).toLowerCase()
        if (process.platform === 'win32' && !['.exe', '.com'].includes(extension)) continue
        if (process.platform !== 'win32') await access(canonical, fsConstants.X_OK)
        const base = basename(canonical).toLowerCase()
        if (BLOCKED_COMMANDS.has(base)) continue
        return canonical
      } catch { /* try next candidate */ }
    }
    throw new Error('Executable was not found as a directly launchable binary. Shell scripts, .cmd/.bat/.ps1 and other wrappers are not supported.')
  }

  private async runCommand(args: Record<string, unknown>): Promise<unknown> {
    const executableInput = stringArg(args.executable, 'executable', 300)
    if (!Array.isArray(args.args) || args.args.length > 64 || args.args.some(arg => typeof arg !== 'string' || arg.length > 4000)) throw new Error('args must be an array of at most 64 strings (each at most 4000 characters).')
    const commandArgs = args.args as string[]
    const executableBase = basename(executableInput).toLowerCase().replace(/\.(exe|com)$/i, '')
    if (['node','nodejs','python','python3','py','deno','bun','ruby','perl','php'].includes(executableBase) && commandArgs.some(arg => /^(-c|--command|-e|--eval|-p|--print|--execute)$/i.test(arg))) {
      throw new Error('Inline interpreter/eval execution is blocked. Use a reviewed workspace script file with an explicit argv instead.')
    }
    if (commandArgs.reduce((sum, item) => sum + Buffer.byteLength(item), 0) > 8_000) throw new Error('Command arguments exceed the 8 KB review/display limit.')
    if (commandArgs.some(arg => redactSecrets(arg).changed)) throw new Error('Likely secrets in command arguments are blocked. Use a scoped credential reference; secrets must not be written to command logs or process arguments.')
    if (this.options.signal.aborted) throw new Error('Task was cancelled before launching a command.')
    const executable = await this.findExecutable(executableInput)
    const displayArgs = commandArgs.map(arg => redactSecrets(arg).value)
    const operation: ProposedOperation = {
      id: randomUUID(), kind: 'execute_command', summary: `Run exact argv: ${JSON.stringify([executable, ...displayArgs])}`.slice(0, 4000), target: executable,
      projectRoot: this.workspaceRoot, parameters: { executable, args: displayArgs, cwd: this.workspaceRoot },
      expectedImpact: 'The process runs with the current user’s OS permissions. It may read or modify project files and invoke network access according to OS/network policy.',
      rollbackInfo: 'Process side effects cannot be reliably rolled back automatically. Review the full argv and use version control/backups before approving.'
    }
    const decision = classifyOperation(operation)
    if (decision.decision === 'deny') throw new Error(decision.reason)
    if (decision.decision === 'require_approval') {
      this.options.onActivity('Approval requested', `${operation.summary} · ${operation.target} · ${decision.reason}`)
      if (!await this.options.requestApproval(operation, this.options.signal)) throw new Error('Command denied or approval expired; it was not launched.')
    }
    const timeoutMs = Math.min(Math.max(this.options.commandTimeoutMs ?? 60_000, 1000), 120_000)
    const env: NodeJS.ProcessEnv = {}
    for (const key of ['PATH','Path','PATHEXT','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','TMPDIR','HOME','USERPROFILE','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA']) if (process.env[key]) env[key] = process.env[key]
    await this.options.onBeforeSideEffect(`Execute ${basename(executable)} with reviewed argv.`)
    let didSpawn = false
    let child: ReturnType<typeof spawn>
    try { child = spawn(executable, commandArgs, { cwd: this.workspaceRoot, env, shell: false, windowsHide: true, stdio: 'pipe' }); didSpawn = true }
    catch (error) { await this.options.onAfterSideEffect('known_not_started', 'Process could not be started.'); throw error }
    return await new Promise((resolvePromise, rejectPromise) => {
      let stdout = '', stderr = '', bytes = 0, killedForLimit = false, finished = false, timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
      const onAbort = () => child.kill()
      this.options.signal.addEventListener('abort', onAbort, { once: true })
      const append = (current: string, chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > MAX_COMMAND_OUTPUT) { killedForLimit = true; child.kill(); return current }
        return current + chunk.toString('utf8')
      }
      child.stdout!.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk) })
      child.stderr!.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk) })
      child.once('error', error => { if (finished) return; finished = true; clearTimeout(timer); this.options.signal.removeEventListener('abort', onAbort); void Promise.resolve(this.options.onAfterSideEffect(didSpawn ? 'possible' : 'known_not_started', 'Process launch error.')).catch(() => undefined); rejectPromise(new Error(`Could not launch process: ${error.message}`)) })
      child.once('close', code => {
        if (finished) return
        finished = true; clearTimeout(timer); this.options.signal.removeEventListener('abort', onAbort)
        const elapsedStatus = this.options.signal.aborted ? 'cancelled' : timedOut ? 'timed_out' : killedForLimit ? 'output_limit' : code === null ? 'terminated' : 'completed'
        const sideEffect = (this.options.signal.aborted || timedOut || killedForLimit || code === null) ? 'possible' : 'known_complete'
        const detail = `Process ended with status ${elapsedStatus} and exit code ${code ?? 'n/a'}.`
        void Promise.resolve(this.options.onAfterSideEffect(sideEffect, detail)).then(() => {
          const result = { executable, args: displayArgs, exitCode: code, status: elapsedStatus, stdout: redactSecrets(stdout).value.slice(0, MAX_COMMAND_OUTPUT), stderr: redactSecrets(stderr).value.slice(0, MAX_COMMAND_OUTPUT), outputTruncated: killedForLimit }
          this.options.onActivity('Command completed', `${basename(executable)} · ${elapsedStatus} · exit ${code ?? 'n/a'}`)
          resolvePromise(result)
        }).catch(error => rejectPromise(new Error(`Command state could not be durably checkpointed: ${error instanceof Error ? error.message : 'unknown error'}`)))
      })
    })
  }
}
