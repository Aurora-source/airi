/** Token counts that a provider reported for one request. */
export interface ReportedUsage {
  promptTokens?: number
  completionTokens?: number
}

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
    let parsed: { usage?: { prompt_tokens?: unknown, completion_tokens?: unknown } }
    try {
      parsed = JSON.parse(payload)
    }
    catch {
      return
    }
    const promptTokens = parsed.usage?.prompt_tokens
    const completionTokens = parsed.usage?.completion_tokens
    if (typeof promptTokens !== 'number' && typeof completionTokens !== 'number')
      return
    found = {
      promptTokens: typeof promptTokens === 'number' ? promptTokens : undefined,
      completionTokens: typeof completionTokens === 'number' ? completionTokens : undefined,
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
