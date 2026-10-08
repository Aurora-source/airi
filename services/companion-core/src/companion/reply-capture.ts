/** The visible part of one model answer, as the gateway saw it. */
export interface CapturedReply {
  text: string
  /** Tool calls of the answer. A non-empty list means the turn continues with another round. */
  toolCalls: { id: string, name: string }[]
  finishReason?: string
  /** The text exceeded the capture limit. The prefix is kept. */
  truncated: boolean
}

export interface ReplyCapture {
  /** Pass the response body through this stream. Every byte leaves unchanged. */
  stream: TransformStream<Uint8Array, Uint8Array>
  /** Complete only after the stream ended. */
  reply: () => CapturedReply
}

const EVENT_BOUNDARY = /\r?\n\r?\n/
const MAX_JSON_BYTES = 2 * 1024 * 1024

interface ChoicePart {
  content?: unknown
  tool_calls?: { id?: unknown, function?: { name?: unknown } }[]
}

/**
 * Taps a chat-completions response and keeps the answer text and tool calls, without changing a byte.
 * Memory uses it to observe the turn and to see which recalled items the answer used.
 */
export function createReplyCapture(contentType: string, maxChars = 16_000): ReplyCapture {
  const isEventStream = contentType.includes('text/event-stream')
  const decoder = new TextDecoder()
  const toolCalls = new Map<string, string>()
  let text = ''
  let truncated = false
  let finishReason: string | undefined
  let pending = ''
  let json = ''
  let jsonOverflow = false

  function append(part: ChoicePart | undefined): void {
    if (typeof part?.content === 'string' && part.content) {
      const room = maxChars - text.length
      if (room < part.content.length)
        truncated = true
      text += part.content.slice(0, Math.max(0, room))
    }
    for (const call of part?.tool_calls ?? []) {
      if (typeof call.id === 'string' && call.id)
        toolCalls.set(call.id, typeof call.function?.name === 'string' ? call.function.name : toolCalls.get(call.id) ?? '')
    }
  }

  function read(payload: string, field: 'delta' | 'message'): void {
    if (!payload.startsWith('{'))
      return
    let parsed: { choices?: ({ finish_reason?: unknown } & Record<string, ChoicePart | unknown>)[] }
    try {
      parsed = JSON.parse(payload)
    }
    catch {
      return
    }
    const choice = parsed.choices?.[0]
    if (!choice)
      return
    append(choice[field] as ChoicePart | undefined)
    if (typeof choice.finish_reason === 'string')
      finishReason = choice.finish_reason
  }

  function readEvents(final: boolean): void {
    for (let match = EVENT_BOUNDARY.exec(pending); match; match = EVENT_BOUNDARY.exec(pending)) {
      const event = pending.slice(0, match.index)
      pending = pending.slice(match.index + match[0].length)
      for (const line of event.split(/\r?\n/)) {
        if (line.startsWith('data:'))
          read(line.slice(5).trim(), 'delta')
      }
    }
    if (final && pending.startsWith('data:'))
      read(pending.slice(5).trim(), 'delta')
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
        read((json + decoder.decode()).trim(), 'message')
      }
    },
  })

  return {
    stream,
    reply: () => ({ text, toolCalls: [...toolCalls].map(([id, name]) => ({ id, name })), finishReason, truncated }),
  }
}
