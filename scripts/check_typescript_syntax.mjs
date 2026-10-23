import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let ts
try {
  ts = await import('typescript')
} catch {
  // Allows syntax-only validation in the constrained build container where npm registry access failed.
  try { ts = await import('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript/lib/typescript.js') }
  catch { console.error('TypeScript package is unavailable. Install development dependencies before running this check.'); process.exit(2) }
}
ts = ts.default ?? ts
const files = []
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'out', 'release', '__pycache__'].includes(entry.name)) continue
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(file)
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) files.push(file)
  }
}
for (const dir of ['src', 'tests']) walk(path.join(root, dir))
const diagnostics = []
for (const file of files) {
  const result = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX }
  })
  for (const item of result.diagnostics ?? []) {
    diagnostics.push(`${path.relative(root, file)}: ${ts.flattenDiagnosticMessageText(item.messageText, '\n')}`)
  }
}
if (diagnostics.length) {
  console.error(diagnostics.map(item => `FAIL: ${item}`).join('\n'))
  process.exit(1)
}
console.log(`PASS: syntax transpilation for ${files.length} TypeScript/TSX source and test files; no syntax diagnostics. This is not a semantic typecheck.`)
