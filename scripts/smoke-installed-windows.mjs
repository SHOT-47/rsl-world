import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const [exe, profile] = process.argv.slice(2)
if (!exe || !profile) throw new Error('Usage: node scripts/smoke-installed-windows.mjs <installed-exe> <profile-dir>')

const port = 9229
const child = spawn(exe, ['--disable-gpu', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], {
  windowsHide: false,
  stdio: 'ignore',
  env: process.env
})
let socket
let nextId = 0
const pending = new Map()
const messages = []
let closed = false

function send(method, params = {}) {
  const id = ++nextId
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP request timed out: ${method}`))
    }, 3000)
    pending.set(id, { resolve, reject, timer })
  })
}

async function main() {
  const deadline = Date.now() + 25000
  let target
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Installed app exited early with code ${child.exitCode}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (response.ok) {
        const targets = await response.json()
        target = targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl)
        if (target) break
      }
    } catch {}
    await delay(250)
  }
  if (!target) throw new Error('Electron DevTools endpoint did not appear; cannot verify renderer startup.')

  socket = new WebSocket(target.webSocketDebuggerUrl)
  socket.addEventListener('message', event => {
    let message
    try { message = JSON.parse(String(event.data)) } catch { return }
    if (message.id && pending.has(message.id)) {
      const item = pending.get(message.id)
      pending.delete(message.id)
      clearTimeout(item.timer)
      if (message.error) item.reject(new Error(message.error.message))
      else item.resolve(message.result)
    } else if (message.method === 'Runtime.exceptionThrown') {
      messages.push(message.params.exceptionDetails?.text ?? 'Renderer exception')
    } else if (message.method === 'Log.entryAdded' && message.params.entry?.level === 'error') {
      messages.push(message.params.entry.text ?? 'Renderer console error')
    }
  })
  socket.addEventListener('close', () => { closed = true })
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('Could not connect to Electron DevTools protocol.')), { once: true })
  })
  await send('Runtime.enable')
  await send('Log.enable')

  const uiDeadline = Date.now() + 20000
  let last = null
  while (Date.now() < uiDeadline) {
    const result = await send('Runtime.evaluate', {
      expression: `JSON.stringify({
        title: document.title,
        rootChildren: document.querySelector('#root')?.children.length ?? -1,
        bridgeType: typeof window.workbench,
        bootstrapType: typeof window.workbench?.getBootstrap,
        bodyText: (document.body?.innerText ?? '').slice(0, 300)
      })`,
      returnByValue: true,
      awaitPromise: true
    })
    const value = result.result?.value
    try { last = JSON.parse(value) } catch { last = null }
    if (last?.rootChildren > 0 && last?.bootstrapType === 'function') break
    if (closed || child.exitCode !== null) throw new Error('Renderer or app exited before the Workbench UI mounted.')
    await delay(500)
  }

  if (!(last?.rootChildren > 0)) throw new Error(`React UI did not mount. Last renderer state: ${JSON.stringify(last)}`)
  if (last.bootstrapType !== 'function') throw new Error(`Preload bridge is missing getBootstrap. Renderer state: ${JSON.stringify(last)}`)
  if (messages.length) throw new Error(`Renderer reported errors during startup: ${messages.slice(0, 5).join(' | ')}`)
  console.log(`PASS: installed Windows app rendered UI and preload bridge. ${JSON.stringify(last)}`)
}

try {
  await main()
} finally {
  try { socket?.close() } catch {}
  if (child.pid && child.exitCode === null) {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  }
}
