import type { ReportedUsage } from '../paid/usage'

export type { ReportedUsage } from '../paid/usage'

export interface UsageSniffer {
  /** Pass the response body through this stream. Every byte leaves unchanged. */
  stream: TransformStream<Uint8Array, Uint8Array>
  /** What the provider reported. Complete only after the stream ended. */
  usage: () => ReportedUsage | undefined
}

/** A JSON body larger than this is not read for usage. Chat completions are far smaller. */
const MAX_JSON_BYTES = 2 * 1024 * 1024
const EVENT_BOUNDARY = /\r?\n\r?\n/

/**
 * Taps a chat-completions response and reads its `usage`, without changing a byte.
 *
 * Event streams carry usage in one chunk near the end, when the client asks for `stream_options.include_usage`.
 * A JSON body carries it at the end of the object. The ledger replaces its estimate with these numbers,
 * and the health tracker learns from the difference.
 */
export function createUsageSniffer(contentType: string): UsageSniffer {
  const isEventStream = contentType.includes('text/event-stream')
  const decoder = new TextDecoder()
  let pending = ''
  let json = ''
  let jsonOverflow = false
  let found: ReportedUsage | undefined

  function read(payload: string): void {
    if (!payload.includes('"usage"'))
      return
    let parsed: { usage?: { prompt_tokens?: unknown, completion_tokens?: unknown, total_tokens?: unknown, prompt_tokens_details?: { cached_tokens?: unknown } | null, completion_tokens_details?: { reasoning_tokens?: unknown } | null } | null }
    try {
      parsed = JSON.parse(payload)
    }
    catch {
      return
    }
    const usage = parsed.usage
    const number = (value: unknown) => typeof value === 'number' ? value : undefined
    if (number(usage?.prompt_tokens) === undefined && number(usage?.completion_tokens) === undefined)
      return
    // A later usage chunk replaces an earlier one, because streamed usage is cumulative.
    found = {
      promptTokens: number(usage?.prompt_tokens),
      completionTokens: number(usage?.completion_tokens),
      totalTokens: number(usage?.total_tokens),
      cachedTokens: number(usage?.prompt_tokens_details?.cached_tokens),
      reasoningTokens: number(usage?.completion_tokens_details?.reasoning_tokens),
    }
  }

  function readEvents(final: boolean): void {
    for (let match = EVENT_BOUNDARY.exec(pending); match; match = EVENT_BOUNDARY.exec(pending)) {
      const event = pending.slice(0, match.index)
      pending = pending.slice(match.index + match[0].length)
      for (const line of event.split(/\r?\n/)) {
        if (line.startsWith('data:'))
          read(line.slice(5).trim())
      }
    }
    if (final && pending.startsWith('data:'))
      read(pending.slice(5).trim())
  }

  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk)
      if (isEventStream) {
        pending += decoder.decode(chunk, { stream: true })
        readEvents(false)
      }
      else if (!jsonOverflow) {
        json += decoder.decode(chunk, { stream: true })
        if (json.length > MAX_JSON_BYTES) {
          jsonOverflow = true
          json = ''
        }
      }
    },
    flush() {
      if (isEventStream) {
        pending += decoder.decode()
        readEvents(true)
      }
      else if (!jsonOverflow) {
        read(json + decoder.decode())
      }
    },
  })

  return { stream, usage: () => found }
}
