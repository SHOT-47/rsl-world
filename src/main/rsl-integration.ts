import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { CaseInitializationResult, CaseValidationResult, RslExportResult, RslHarnessId, RslValidationResult } from '@shared/contracts'
import { redactSecrets } from './redaction.ts'
import { resolvePythonRuntime, runTrustedPythonScript } from './runtime/python-runtime.ts'

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function safeDetails(output: string, errorOutput: string): string[] {
  return `${output}\n${errorOutput}`.split(/\r?\n/).map(line => redactSecrets(line).value.trim()).filter(Boolean).slice(0, 80)
}

export class RslIntegration {
  private readonly libraryRoot: string

  constructor(libraryRoot: string) {
    if (!isAbsolute(libraryRoot)) throw new Error('RSL library root must be an absolute path.')
    this.libraryRoot = libraryRoot
  }

  async version(): Promise<string | null> {
    try {
      const readme = await readFile(join(this.libraryRoot, 'README.md'), 'utf8')
      return readme.match(/^\*\*Version:\*\*\s*([^\s]+)\s*$/m)?.[1] ?? null
    } catch { return null }
  }

  async validatePackage(): Promise<RslValidationResult> {
    const version = await this.version()
    const scriptPath = join(this.libraryRoot, 'validation', 'check_library.py')
    try {
      const [rootInfo, scriptInfo] = await Promise.all([stat(this.libraryRoot), stat(scriptPath)])
      if (!rootInfo.isDirectory() || !scriptInfo.isFile() || !version) {
        return { available: false, version, passed: false, summary: 'Bundled RSL library or validator is missing.', details: [] }
      }
      const python = resolvePythonRuntime()
      const result = await runTrustedPythonScript({ executable: python.executable, scriptPath, args: [], cwd: this.libraryRoot, timeoutMs: 45_000, maxOutputBytes: 1_000_000 })
      const details = safeDetails(result.stdout, result.stderr)
      const passed = result.code === 0 && /^PASS:/m.test(result.stdout)
      return {
        available: true,
        version,
        passed,
        summary: passed ? 'Bundled RSL package validation passed.' : `RSL validation failed${result.code === null ? '' : ` (exit ${result.code})`}.`,
        details
      }
    } catch (error) {
      return {
        available: Boolean(version), version, passed: false,
        summary: error instanceof Error ? redactSecrets(error.message).value : 'Could not run the RSL package validator.',
        details: []
      }
    }
  }

  async initializeCase(projectRootInput: string): Promise<CaseInitializationResult> {
    try {
      if (!isAbsolute(projectRootInput)) throw new Error('Project root must be absolute.')
      const projectRoot = await realpath(projectRootInput)
      if (!(await stat(projectRoot)).isDirectory()) throw new Error('Project root is not a directory.')
      const caseRoot = join(projectRoot, 'case')
      try {
        await stat(caseRoot)
        return { created: false, caseRoot, summary: 'A case directory already exists; nothing was changed.' }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await mkdir(caseRoot, { recursive: false })
      const readme = [
        '# RSL Investigation Case',
        '',
        'This directory is an empty case scaffold. It contains no inferred capability data or analysis claims.',
        '',
        'Required workflow order:',
        '1. Detect the active harness and capabilities; populate `capabilities.json` with observed results and evidence references.',
        '2. Run the target-reuse search before triage; record scope, timestamp, results, limitations and uncertainty.',
        '3. Create `triage.json` using the bundled `routing.yaml` as the routing source of truth.',
        '4. Add evidence artifacts and `evidence/records/*.json` metadata sidecars with SHA-256 hashes.',
        '5. Add claims only when they link to preserved evidence; `proven` requires a passed verification gate.',
        '6. Run Workbench case validation before reporting results.',
        '',
        'Do not populate capabilities or findings with guessed values. Unknown capabilities must be recorded as unknown.',
        ''
      ].join('\n')
      await writeFile(join(caseRoot, 'README.md'), readme, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      return { created: true, caseRoot, summary: 'Empty case scaffold created. Capability detection and evidence are intentionally not fabricated.' }
    } catch (error) {
      return { created: false, caseRoot: null, summary: error instanceof Error ? redactSecrets(error.message).value : 'Could not initialize the RSL case scaffold.' }
    }
  }

  async exportSkill(harness: RslHarnessId, destinationInput: string): Promise<RslExportResult> {
    const supported: RslHarnessId[] = ['claude-code', 'cursor', 'codex', 'gemini-cli', 'copilot', 'opencode', 'cline', 'windsurf', 'grok-build', 'generic']
    if (!supported.includes(harness)) return { exported: false, harness: String(harness), destination: null, summary: 'Unsupported harness profile.', details: [] }
    try {
      if (!isAbsolute(destinationInput)) throw new Error('Export destination must be an absolute path selected by the native folder picker.')
      const destination = await realpath(destinationInput)
      if (!(await stat(destination)).isDirectory()) throw new Error('Export destination must be an existing directory.')
      const scriptPath = join(this.libraryRoot, 'validation', 'export_skill.py')
      const scriptInfo = await stat(scriptPath)
      if (!scriptInfo.isFile()) throw new Error('The bundled RSL exporter is missing.')
      const python = resolvePythonRuntime()
      const result = await runTrustedPythonScript({ executable: python.executable, scriptPath, args: ['--harness', harness, '--dest', destination], cwd: this.libraryRoot, timeoutMs: 45_000, maxOutputBytes: 1_000_000 })
      const details = safeDetails(result.stdout, result.stderr)
      const exported = result.code === 0 && /exported|created|success/i.test(result.stdout)
      return { exported, harness, destination, summary: exported ? `RSL skill export completed for ${harness}.` : `RSL skill export failed${result.code === null ? '' : ` (exit ${result.code})`}.`, details }
    } catch (error) {
      return { exported: false, harness, destination: null, summary: error instanceof Error ? redactSecrets(error.message).value : 'RSL export failed.', details: [] }
    }
  }

  async validateCase(projectRootInput: string): Promise<CaseValidationResult> {
    let projectRoot: string
    try {
      if (!isAbsolute(projectRootInput)) throw new Error('Project root must be absolute.')
      projectRoot = await realpath(projectRootInput)
      const projectInfo = await stat(projectRoot)
      if (!projectInfo.isDirectory()) throw new Error('Project root is not a directory.')
      const caseCandidate = join(projectRoot, 'case')
      const caseRoot = await realpath(caseCandidate)
      if (!within(projectRoot, caseRoot)) throw new Error('Case directory escapes the registered project root.')
      const caseInfo = await stat(caseRoot)
      if (!caseInfo.isDirectory()) throw new Error('The project case path is not a directory.')
      const scriptPath = join(this.libraryRoot, 'validation', 'validate_case.py')
      const scriptInfo = await stat(scriptPath)
      if (!scriptInfo.isFile()) throw new Error('The bundled RSL case validator is missing.')
      const python = resolvePythonRuntime()
      const result = await runTrustedPythonScript({ executable: python.executable, scriptPath, args: [caseRoot, '--json'], cwd: projectRoot, timeoutMs: 30_000, maxOutputBytes: 1_000_000 })
      let payload: Record<string, unknown> = {}
      try { payload = JSON.parse(result.stdout) as Record<string, unknown> } catch { /* surfaced as a failed contract below */ }
      const passed = result.code === 0 && payload.status === 'PASS'
      const errors = Array.isArray(payload.errors) ? payload.errors.map(value => redactSecrets(String(value)).value).slice(0, 100) : safeDetails(result.stdout, result.stderr)
      const counts = payload.counts && typeof payload.counts === 'object' ? payload.counts as Record<string, number> : undefined
      return {
        available: true,
        caseRoot,
        passed,
        summary: passed ? 'RSL case/evidence validation passed.' : 'RSL case/evidence validation failed; review the listed errors.',
        errors,
        counts
      }
    } catch (error) {
      return {
        available: true,
        caseRoot: null,
        passed: false,
        summary: error instanceof Error ? redactSecrets(error.message).value : 'Case validation failed.',
        errors: []
      }
    }
  }
}
