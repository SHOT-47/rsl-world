import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const builderScript = await readFile(new URL('../scripts/build-windows.ps1', import.meta.url), 'utf8')
const workflow = await readFile(new URL('../.github/workflows/windows-nsis.yml', import.meta.url), 'utf8')
const buildGuide = await readFile(new URL('../docs/WINDOWS_BUILD.md', import.meta.url), 'utf8')

test('package metadata targets x64 NSIS and gives native SQLite an unpacked runtime path', () => {
  assert.match(packageJson.scripts['package:win'], /electron-builder --win nsis --x64$/)
  assert.deepEqual(packageJson.build.win.target, ['nsis'])
  assert.equal(packageJson.build.win.icon, 'resources/app.ico')
  assert.ok(packageJson.build.asarUnpack.includes('node_modules/better-sqlite3/**'))
})

test('Windows build script refuses non-Windows execution and enforces test gates by default', () => {
  assert.match(builderScript, /\$env:OS -ne 'Windows_NT'/)
  assert.match(builderScript, /npm.*ci/)
  assert.match(builderScript, /npm.*install/)
  assert.match(builderScript, /npm.*run.*typecheck/)
  assert.match(builderScript, /npm.*test/)
  assert.match(builderScript, /electron-builder.*--win.*nsis.*--x64/)
  assert.match(builderScript, /Get-FileHash.*SHA256/)
  assert.match(builderScript, /testsSkipped/)
})

test('Windows CI packages on a Windows runner and uploads provenance with installer', () => {
  assert.match(workflow, /runs-on:\s*windows-(?:latest|2022)/)
  assert.match(workflow, /node-version:\s*'22\.16\.0'/)
  assert.match(workflow, /python-version:\s*'3\.12'/)
  assert.match(workflow, /npm run package:win/)
  assert.match(workflow, /actions\/upload-artifact@v4/)
  assert.match(workflow, /release\/\*Setup\.exe/)
  assert.match(workflow, /SHA256SUMS\.txt/)
  assert.match(workflow, /build-manifest\.json/)
  assert.doesNotMatch(workflow, /softprops\/action-gh-release|gh release create/)
})

test('Windows build documentation does not claim installer is prebuilt or signed', () => {
  assert.match(buildGuide, /Neither creates an installer until it is actually run/)
  assert.match(buildGuide, /unsigned/)
  assert.match(buildGuide, /package-lock\.json/)
})

test('Windows app icon is a valid multi-resolution ICO file', async () => {
  const buf = await readFile(new URL('../resources/app.ico', import.meta.url))
  assert.ok(buf.length > 500)
  assert.equal(buf.readUInt16LE(0), 0, 'ICO reserved field')
  assert.equal(buf.readUInt16LE(2), 1, 'ICO type field')
  assert.ok(buf.readUInt16LE(4) >= 5, 'expected multiple icon sizes')
  await stat(new URL('../resources/tray.png', import.meta.url))
})
