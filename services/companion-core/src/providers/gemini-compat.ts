/** One streamed tool-call fragment, as OpenAI-compatible providers send it inside `choices[].delta.tool_calls`. */
interface ToolCallDelta {
  index?: number
  id?: string
  [key: string]: unknown
}

/** End of one server-sent event: a blank line, with LF or CRLF line endings. */
const EVENT_BOUNDARY = /\r?\n\r?\n/

/**
 * Adds the missing `index` to streamed tool-call fragments from the Gemini OpenAI-compatible endpoint.
 *
 * Gemini omits `choices[].delta.tool_calls[].index`. OpenAI clients, such as AIRI's xsAI client,
 * assemble tool calls by that index, so they drop every Gemini tool call. This adapter restores
 * the index and changes nothing else.
 *
 * Index policy, per stream and per choice:
 * - A fragment that already has an `index` passes through unchanged.
 * - A fragment with a new `id` gets the next index, starting at 0. The same `id` always maps to the same index.
 * - A fragment without `id` continues the most recent tool call of its choice, so fragmented arguments stay together.
 *
 * Events without index-less tool calls, comments, `[DONE]`, and unparsable events are re-emitted byte for byte.
 * `finish_reason` and fields such as `extra_content.google.thought_signature` are never changed.
 *
 * @example
 * // input event:  data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_a","function":{"name":"f","arguments":"{}"}}]}}]}
 * // output event: data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_a","function":{"name":"f","arguments":"{}"},"index":0}]}}]}
 */
export function createGeminiToolCallIndexer(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  /** Choice index -> (tool-call id -> assigned index). */
  const idsByChoice = new Map<number, Map<string, number>>()
  /** Choice index -> index of the most recent tool call, for fragments without an id. */
  const lastByChoice = new Map<number, number>()
  let pending = ''

  function indexFor(choice: number, call: ToolCallDelta): number {
    let ids = idsByChoice.get(choice)
    if (!ids) {
      ids = new Map()
      idsByChoice.set(choice, ids)
    }
    if (call.id === undefined) {
      // A fragment without an id belongs to the call that is still streaming.
      return lastByChoice.get(choice) ?? 0
    }
    let assigned = ids.get(call.id)
    if (assigned === undefined) {
      assigned = ids.size
      ids.set(call.id, assigned)
    }
    lastByChoice.set(choice, assigned)
    return assigned
  }

  /** Returns the event unchanged unless it holds an index-less tool-call fragment. */
  function rewrite(event: string): string {
    const lines = event.split(/(\r?\n)/)
    let changed = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line.startsWith('data:'))
        continue
      const payload = line.slice(5).trimStart()
      if (!payload.includes('"tool_calls"'))
        continue
      let parsed: { choices?: { index?: number, delta?: { tool_calls?: ToolCallDelta[] } }[] }
      try {
        parsed = JSON.parse(payload)
      }
      catch {
        // Not JSON, for example a partial or malformed event. Leave it for the client to judge.
        continue
      }
      let lineChanged = false
      for (const choice of parsed.choices ?? []) {
        for (const call of choice.delta?.tool_calls ?? []) {
          if (call.index !== undefined) {
            if (call.id !== undefined)
              lastByChoice.set(choice.index ?? 0, call.index)
            continue
          }
          call.index = indexFor(choice.index ?? 0, call)
          lineChanged = true
        }
      }
      if (lineChanged) {
        lines[i] = `data: ${JSON.stringify(parsed)}`
        changed = true
      }
    }
    return changed ? lines.join('') : event
  }

  function flushEvents(controller: TransformStreamDefaultController<Uint8Array>, final: boolean) {
    for (let match = EVENT_BOUNDARY.exec(pending); match; match = EVENT_BOUNDARY.exec(pending)) {
      const end = match.index + match[0].length
      const event = pending.slice(0, end)
      pending = pending.slice(end)
      controller.enqueue(encoder.encode(rewrite(event)))
    }
    if (final && pending) {
      // A stream that ends without a closing blank line keeps its last bytes unchanged.
      controller.enqueue(encoder.encode(pending))
      pending = ''
    }
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true })
      flushEvents(controller, false)
    },
    flush(controller) {
      pending += decoder.decode()
      flushEvents(controller, true)
    },
  })
}
