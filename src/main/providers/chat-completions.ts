import type { ProviderRuntimeConfig } from './provider-store.ts'
import { requestPinnedHttp, resolveProviderEndpoint } from './openai-compatible.ts'

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'
export interface ChatToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface ChatMessage {
  role: ChatRole
  content: string | null
  name?: string
  tool_call_id?: string
  tool_calls?: ChatToolCall[]
}
export interface ChatToolDefinition { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export interface ChatCompletionResult {
  content: string | null
  toolCalls: ChatToolCall[]
  finishReason: string | null
  usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
}

function safeTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export async function requestChatCompletion(
  provider: ProviderRuntimeConfig,
  messages: ChatMessage[],
  tools: ChatToolDefinition[],
  options: { timeoutMs?: number; maxResponseBytes?: number; maxTokens?: number; signal?: AbortSignal } = {}
): Promise<ChatCompletionResult> {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 80) throw new Error('Chat request contains an invalid number of messages.')
  if (!Array.isArray(tools) || tools.length > 32) throw new Error('Chat request contains an invalid number of tool definitions.')
  const resolved = await resolveProviderEndpoint(provider)
  if (!resolved.result) throw new Error(`Provider request blocked: ${resolved.error ?? 'endpoint unavailable'}`)

  const payload = JSON.stringify({
    model: provider.model,
    messages,
    ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
    max_tokens: Math.min(Math.max(options.maxTokens ?? 4096, 64), 8192),
    temperature: 0.1
  })
  if (Buffer.byteLength(payload, 'utf8') > 500_000) throw new Error('Chat request exceeded the 500 KB payload limit.')
  const endpoint = new URL(`${resolved.result.endpointBase.replace(/\/+$/, '')}/chat/completions`)
  const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'RSL-Workbench-Agent/0.1' }
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`
  const response = await requestPinnedHttp(endpoint, headers, options.timeoutMs ?? 60_000, resolved.result.address, {
    method: 'POST', body: payload, maxResponseBytes: options.maxResponseBytes ?? 2_000_000, signal: options.signal
  })
  if (response.status < 200 || response.status >= 300) {
    const auth = response.status === 401 || response.status === 403
    const detail = auth ? 'Provider authentication failed.' : response.status === 429 ? 'Provider rate limit was reached.' : response.status >= 500 ? 'Provider returned a server error.' : response.status >= 300 ? 'Provider redirects are not followed; configure the final endpoint.' : 'Provider rejected the chat-completion request.'
    throw new Error(`Chat request failed with HTTP ${response.status}. ${detail}`)
  }
  let result: unknown
  try { result = JSON.parse(response.body) } catch { throw new Error('Provider chat-completion response was not valid JSON.') }
  const object = result as { choices?: unknown; usage?: unknown }
  if (!object || !Array.isArray(object.choices) || object.choices.length === 0) throw new Error('Provider response did not include choices[].')
  const choice = object.choices[0] as { finish_reason?: unknown; message?: unknown }
  const message = choice?.message as { content?: unknown; tool_calls?: unknown } | undefined
  if (!message || (message.content !== null && message.content !== undefined && typeof message.content !== 'string')) throw new Error('Provider response has an invalid assistant message.')
  const toolCalls: ChatToolCall[] = []
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls.slice(0, 32)) {
      if (!call || typeof call !== 'object') continue
      const raw = call as { id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } }
      if (raw.type !== 'function' || typeof raw.id !== 'string' || raw.id.length > 200 || typeof raw.function?.name !== 'string' || raw.function.name.length > 100 || typeof raw.function.arguments !== 'string' || raw.function.arguments.length > 100_000) continue
      toolCalls.push({ id: raw.id, type: 'function', function: { name: raw.function.name, arguments: raw.function.arguments } })
    }
  }
  const usage = (object.usage && typeof object.usage === 'object') ? object.usage as Record<string, unknown> : {}
  return {
    content: typeof message.content === 'string' ? message.content.slice(0, 100_000) : null,
    toolCalls,
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason.slice(0, 50) : null,
    usage: {
      promptTokens: safeTokenCount(usage.prompt_tokens), completionTokens: safeTokenCount(usage.completion_tokens), totalTokens: safeTokenCount(usage.total_tokens)
    }
  }
}
