import type { IpcMainInvokeEvent } from 'electron'

export interface SenderPolicy {
  expectedWebContentsId: number
  isAllowedUrl(url: string): boolean
}

/** Reject IPC from frames that are not the single trusted application renderer. */
export function assertTrustedSender(event: IpcMainInvokeEvent, policy: SenderPolicy): void {
  const frameUrl = event.senderFrame?.url
  if (event.sender.id !== policy.expectedWebContentsId || !frameUrl || !policy.isAllowedUrl(frameUrl)) {
    const error = new Error('IPC request rejected: untrusted renderer sender')
    error.name = 'UnauthorizedSenderError'
    throw error
  }
}

export function isAllowedRendererUrl(candidate: string, devServerUrl?: string): boolean {
  try {
    const target = new URL(candidate)
    if (devServerUrl) {
      const dev = new URL(devServerUrl)
      return target.origin === dev.origin && target.pathname === dev.pathname
    }
    return target.protocol === 'file:' && target.pathname.endsWith('/index.html')
  } catch {
    return false
  }
}

export function buildContentSecurityPolicy(isDev: boolean): string {
  const connect = isDev ? "connect-src 'self' http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*" : "connect-src 'self'"
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    connect,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'"
  ].join('; ')
}
