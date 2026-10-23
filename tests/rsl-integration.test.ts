import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { RslIntegration } from '../src/main/rsl-integration.ts'

const LIBRARY = resolve('resources/reverse-skill-library')

test('bundled RSL version is read from the package source', async () => {
  const integration = new RslIntegration(LIBRARY)
  assert.equal(await integration.version(), '3.1.0-remediated')
})

test('RSL package validation invokes the actual bundled checker', async () => {
  const integration = new RslIntegration(LIBRARY)
  const result = await integration.validatePackage()
  assert.equal(result.available, true)
  assert.equal(result.passed, true, result.details.join('\n'))
  assert.match(result.details.join('\n'), /370 static\/schema assertions/)
})

test('case validation fails closed when project case directory does not exist', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rsl-case-'))
  try {
    const integration = new RslIntegration(LIBRARY)
    const result = await integration.validateCase(temp)
    assert.equal(result.available, true)
    assert.equal(result.passed, false)
    assert.equal(result.caseRoot, null)
    assert.match(result.summary, /case/i)
  } finally { await rm(temp, { recursive: true, force: true }) }
})

test('case validation rejects a case directory symlink that escapes the project root', async () => {
  if (process.platform === 'win32') return
  const temp = await mkdtemp(join(tmpdir(), 'rsl-case-'))
  const project = join(temp, 'project')
  const outsider = join(temp, 'outsider')
  try {
    await mkdir(project)
    await mkdir(outsider)
    const { symlink } = await import('node:fs/promises')
    await symlink(outsider, join(project, 'case'))
    const result = await new RslIntegration(LIBRARY).validateCase(project)
    assert.equal(result.passed, false)
    assert.match(result.summary, /escapes the registered project root/)
  } finally { await rm(temp, { recursive: true, force: true }) }
})


test('every declared harness profile can export a separate portable skill package', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rsl-all-exports-'))
  const integration = new RslIntegration(LIBRARY)
  const harnesses: Array<'claude-code' | 'cursor' | 'codex' | 'gemini-cli' | 'copilot' | 'opencode' | 'cline' | 'windsurf' | 'grok-build' | 'generic'> = ['claude-code','cursor','codex','gemini-cli','copilot','opencode','cline','windsurf','grok-build','generic']
  try {
    for (const harness of harnesses) {
      const destination = join(temp, harness)
      await mkdir(destination)
      const result = await integration.exportSkill(harness, destination)
      assert.equal(result.exported, true, `${harness}: ${result.summary}; ${result.details.join(' | ')}`)
      const manifest = join(destination, 'reverse-skill-library', 'SKILL.md')
      assert.equal((await stat(manifest)).isFile(), true, `${harness} manifest missing`)
    }
  } finally { await rm(temp, { recursive: true, force: true }) }
})
