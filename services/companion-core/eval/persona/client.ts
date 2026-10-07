import { Buffer } from 'node:buffer'

/** One tool call that the model streamed. `extra` is the provider's own field, for example Gemini's thought signature. */
export interface StreamedToolCall {
  id?: string
  name?: string
  arguments: string
  extra?: unknown
}

export interface Completion {
  status: number
  text: string
  toolCalls: StreamedToolCall[]
  /** The stream carried reasoning text in a field of its own. */
  reasoningChannel: boolean
  finishReason?: string
  usage?: { promptTokens?: number, completionTokens?: number }
  firstByteMs?: number
  totalMs: number
  /** The `x-companion-model` header: the model that served the request. */
  servedBy?: string
  error?: string
  /** Time that the client waited for rate limits before the request that succeeded. */
  waitedMs: number
}

export interface ClientOptions {
  /** For example `http://127.0.0.1:11980/`. */
  baseURL: string
  token: string
  /** The longest that one call waits in total for rate limits and retries. */
  maxWaitMs?: number
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_MAX_WAIT_MS = 10 * 60_000
const MAX_RETRY_AFTER_MS = 90_000

/**
 * Sends chat requests to the Companion Gateway and reads the stream like AIRI's client does.
 *
 * A 429 with a `Retry-After` is a gateway or provider asking to wait, so the client waits and sends again.
 * A network error or a 5xx gets two retries. A 413 or a 400 is final, because the same request fails the same way.
 */
export class GatewayClient {
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxWaitMs: number

  constructor(private readonly options: ClientOptions) {
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
  }

  async complete(model: string, body: Record<string, unknown>): Promise<Completion> {
    const started = performance.now()
    let waitedMs = 0
    let serverErrors = 0
    for (;;) {
      const attempt = await this.once(model, body)
      const totalMs = Math.round(performance.now() - started)
      if (attempt.status === 429 && waitedMs < this.maxWaitMs) {
        const wait = Math.min(attempt.retryAfterMs ?? 5000, MAX_RETRY_AFTER_MS) + 250
        waitedMs += wait
        await this.sleep(wait)
        continue
      }
      if ((attempt.status === 0 || attempt.status >= 500) && serverErrors < 2) {
        serverErrors++
        waitedMs += 3000
        await this.sleep(3000)
        continue
      }
      return { ...attempt.completion, totalMs, waitedMs }
    }
  }

  private async once(model: string, body: Record<string, unknown>): Promise<{ status: number, retryAfterMs?: number, completion: Omit<Completion, 'totalMs' | 'waitedMs'> }> {
    const started = performance.now()
    const empty = { text: '', toolCalls: [], reasoningChannel: false }
    let response: Response
    try {
      response = await fetch(new URL('v1/chat/completions', this.options.baseURL), {
        method: 'POST',
        headers: { 'authorization': `Bearer ${this.options.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ stream: true, stream_options: { include_usage: true }, ...body, model }),
        signal: AbortSignal.timeout(120_000),
      })
    }
    catch (error) {
      return { status: 0, completion: { ...empty, status: 0, error: String(error).slice(0, 200) } }
    }

    const servedBy = response.headers.get('x-companion-model') ?? undefined
    if (!response.ok) {
      const text = (await response.text().catch(() => '')).slice(0, 400)
      const retryAfter = Number(response.headers.get('retry-after'))
      return {
        status: response.status,
        retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
        completion: { ...empty, status: response.status, servedBy, error: text },
      }
    }

    let firstByteMs: number | undefined
    let raw = ''
    try {
      for await (const chunk of response.body!) {
        firstByteMs ??= Math.round(performance.now() - started)
        raw += Buffer.from(chunk).toString('utf8')
      }
    }
    catch (error) {
      return { status: 502, completion: { ...empty, status: 502, servedBy, firstByteMs, error: `stream broke: ${String(error).slice(0, 120)}` } }
    }
    return { status: 200, completion: { ...parseStream(raw), status: 200, servedBy, firstByteMs } }
  }
}

/** Reads an event stream into text, tool calls, finish reason, and usage. A JSON body is read the same way. */
export function parseStream(raw: string): Pick<Completion, 'text' | 'toolCalls' | 'reasoningChannel' | 'finishReason' | 'usage'> {
  let text = ''
  let reasoningChannel = false
  let finishReason: string | undefined
  let usage: Completion['usage']
  const calls: StreamedToolCall[] = []

  const read = (event: {
    choices?: { delta?: Record<string, unknown>, message?: Record<string, unknown>, finish_reason?: string }[]
    usage?: { prompt_tokens?: number, completion_tokens?: number }
  }) => {
    const choice = event.choices?.[0]
    const delta = (choice?.delta ?? choice?.message) as {
      content?: unknown
      reasoning?: unknown
      reasoning_content?: unknown
      tool_calls?: { index?: number, id?: string, extra_content?: unknown, function?: { name?: string, arguments?: string } }[]
    } | undefined
    if (typeof delta?.content === 'string')
      text += delta.content
    if ((typeof delta?.reasoning === 'string' && delta.reasoning !== '') || (typeof delta?.reasoning_content === 'string' && delta.reasoning_content !== ''))
      reasoningChannel = true
    for (const call of delta?.tool_calls ?? []) {
      // Without an index, a new id starts a call and a fragment without an id continues the last one.
      const index = call.index ?? (call.id ? calls.length : Math.max(calls.length - 1, 0))
      const slot = calls[index] ?? (calls[index] = { arguments: '' })
      if (call.id)
        slot.id = call.id
      if (call.function?.name)
        slot.name = call.function.name
      if (call.function?.arguments)
        slot.arguments += call.function.arguments
      if (call.extra_content)
        slot.extra = call.extra_content
    }
    if (choice?.finish_reason)
      finishReason = choice.finish_reason
    if (event.usage)
      usage = { promptTokens: event.usage.prompt_tokens, completionTokens: event.usage.completion_tokens }
  }

  const lines = raw.split(/\r?\n/).filter(line => line.startsWith('data:'))
  if (lines.length === 0) {
    try {
      read(JSON.parse(raw))
    }
    catch {
      // Not JSON either. The caller sees an empty answer.
    }
  }
  for (const line of lines) {
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]')
      continue
    try {
      read(JSON.parse(payload))
    }
    catch {
      // A broken event is skipped. The parts around it still count.
    }
  }
  return { text, toolCalls: calls.filter(Boolean), reasoningChannel, finishReason, usage }
}
