/** Best-effort safety net, not a substitute for avoiding collection of secrets. */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|sk_live_[A-Za-z0-9]{12,}|sk_test_[A-Za-z0-9]{12,})\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:xox[baprs]-)[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}={0,2}/gi,
  /\b(authorization\s*:\s*)(?:basic|bearer)\s+[^\s,;]+/gi,
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret)\s*([=:])\s*["']?([^\s"'&,;]{4,})["']?/gi,
  /\b(password|passwd|client_secret|api_key|access_token|refresh_token)\s*:\s*["'][^"']+["']/gi
]

export function redactSecrets(input: string): { value: string; changed: boolean } {
  // Preserve valid JSON while redacting values from common secret-bearing keys. The generic
  // assignment patterns below are a secondary safety net for non-JSON text and may not match
  // quoted JSON keys by design.
  let value = input.replace(
    /(\"(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|authorization|private[_-]?key|credential[_-]?value)\"\s*:\s*)(\"(?:\\\\.|[^\"\\\\])*\"|[^,}\]\s]+)/gi,
    (_match, prefix: string) => `${prefix}\"[REDACTED]\"`
  )
  for (const pattern of SECRET_PATTERNS) {
    // Retain a useful key name where the pattern captures it; never preserve the value.
    value = value.replace(pattern, (match: string, ...args: unknown[]) => {
      const groups = args.slice(0, -2).filter((arg): arg is string => typeof arg === 'string')
      const label = groups.length > 0 ? groups[0] : null
      if (label && /^(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret)$/i.test(label)) {
        return `${label}=[REDACTED]`
      }
      return '[REDACTED]'
    })
  }
  return { value, changed: value !== input }
}

const SENSITIVE_FIELD = /(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|private[_-]?key|credential[_-]?value)/i

export function sanitizeJson(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value).value
  if (Array.isArray(value)) return value.map(sanitizeJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      SENSITIVE_FIELD.test(key) && child !== null && child !== undefined ? '[REDACTED]' : sanitizeJson(child)
    ]))
  }
  return value
}

export function boundedText(value: unknown, maxLength: number, fieldName: string): string {
  if (typeof value !== 'string') throw new Error(`${fieldName} must be a string`)
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${fieldName} must not be empty`)
  if (trimmed.length > maxLength) throw new Error(`${fieldName} exceeds ${maxLength} characters`)
  return trimmed
}
