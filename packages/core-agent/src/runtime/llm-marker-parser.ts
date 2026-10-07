const TAG_OPEN = '<|'
const TAG_CLOSE = '|>'
const ESCAPED_TAG_OPEN = '<{\'|\'}'
const ESCAPED_TAG_CLOSE = '{\'|\'}>'

const ACT_OPEN = /^<\|ACT\s+/
// NOTICE:
// Models close ACT markers with mistyped closers, for example `}%>`, `}#>`, `}>`, `}-->`, or `}||>`.
// The marker then never closes, so the speech after it is withheld or dropped.
// Source: R2B persona benchmark, Gemini 3.x Flash-Lite and Groq Qwen replies.
// Removal condition: none while hosted models write these closers.
const ACT_CLOSER = /^[ \t]*(?:[!#%/@|~-]\uFE0F?){0,2}>/
const ACT_CLOSER_PREFIX = /^[ \t]*(?:[!#%/@|~-]\uFE0F?){0,2}$/
const STANDARD_CLOSER = /^[ \t]*\|>$/

type ActMarkerEnd
  = | { status: 'pending' }
    | { status: 'closed', length: number, special: string }

/** Index of the brace that closes the JSON object at `start`, or -1 while the object is still open. */
function jsonObjectEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped)
        escaped = false
      else if (char === '\\')
        escaped = true
      else if (char === '"')
        inString = false
    }
    else if (char === '"') {
      inString = true
    }
    else if (char === '{') {
      depth++
    }
    else if (char === '}' && --depth === 0) {
      return index
    }
  }
  return -1
}

/**
 * Finds where an ACT marker with a JSON payload ends when the model mistypes its closer.
 *
 * Returns:
 * - `undefined` when the standard `|>` search applies: not an ACT payload, a `|>` before the payload ends, or text after it.
 * - `pending` while the next characters decide between those cases.
 * - `closed` with the canonical `<|ACT {...}|>` text when a known closer follows the payload.
 */
function findActMarkerEnd(buffer: string): ActMarkerEnd | undefined {
  const open = ACT_OPEN.exec(buffer)
  if (!open)
    return /^<\|(?:A(?:C(?:T\s*)?)?)?$/.test(buffer) ? { status: 'pending' } : undefined

  const payloadStart = open[0].length
  if (payloadStart === buffer.length)
    return { status: 'pending' }
  if (buffer[payloadStart] !== '{')
    return undefined

  const payloadEnd = jsonObjectEnd(buffer, payloadStart)
  const standardClose = buffer.indexOf(TAG_CLOSE, payloadStart)
  if (payloadEnd < 0)
    return standardClose < 0 ? { status: 'pending' } : undefined
  if (standardClose >= 0 && standardClose < payloadEnd)
    return undefined

  const rest = buffer.slice(payloadEnd + 1)
  const closer = ACT_CLOSER.exec(rest)
  if (closer) {
    const raw = buffer.slice(0, payloadEnd + 1 + closer[0].length)
    return { status: 'closed', length: raw.length, special: STANDARD_CLOSER.test(closer[0]) ? raw : `${buffer.slice(0, payloadEnd + 1)}${TAG_CLOSE}` }
  }
  return ACT_CLOSER_PREFIX.test(rest) ? { status: 'pending' } : undefined
}

interface MarkerToken {
  type: 'literal' | 'special'
  value: string
}

interface MarkerParserOptions {
  minLiteralEmitLength?: number
}

interface StreamController<T> {
  stream: ReadableStream<T>
  write: (value: T) => void
  close: () => void
  error: (err: unknown) => void
}

function createPushStream<T>(): StreamController<T> {
  let closed = false
  let controller: ReadableStreamDefaultController<T> | null = null

  const stream = new ReadableStream<T>({
    start(ctrl) {
      controller = ctrl
    },
    cancel() {
      closed = true
    },
  })

  return {
    stream,
    write(value) {
      if (!controller || closed)
        return
      controller.enqueue(value)
    },
    close() {
      if (!controller || closed)
        return
      closed = true
      controller.close()
    },
    error(err) {
      if (!controller || closed)
        return
      closed = true
      controller.error(err)
    },
  }
}

async function readStream<T>(stream: ReadableStream<T>, handler: (value: T) => Promise<void> | void) {
  const reader = stream.getReader()
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done)
        break
      await handler(value as T)
    }
  }
  finally {
    reader.releaseLock()
  }
}

function createLlmMarkerParser(options?: MarkerParserOptions) {
  const minLiteralEmitLength = Math.max(1, options?.minLiteralEmitLength ?? 1)
  const tailLength = Math.max(TAG_OPEN.length - 1, ESCAPED_TAG_OPEN.length - 1)
  let buffer = ''
  let inTag = false

  return {
    async consume(textPart: string, onLiteral: (value: string) => Promise<void> | void, onSpecial: (value: string) => Promise<void> | void) {
      buffer += textPart
      buffer = buffer
        .replaceAll(ESCAPED_TAG_OPEN, TAG_OPEN)
        .replaceAll(ESCAPED_TAG_CLOSE, TAG_CLOSE)

      while (buffer.length > 0) {
        if (!inTag) {
          const openTagIndex = buffer.indexOf(TAG_OPEN)
          if (openTagIndex < 0) {
            if (buffer.length - tailLength >= minLiteralEmitLength) {
              const emit = buffer.slice(0, -tailLength)
              buffer = buffer.slice(-tailLength)
              await onLiteral(emit)
            }
            break
          }

          if (openTagIndex > 0) {
            const emit = buffer.slice(0, openTagIndex)
            buffer = buffer.slice(openTagIndex)
            await onLiteral(emit)
          }
          inTag = true
        }
        else {
          const act = findActMarkerEnd(buffer)
          if (act?.status === 'pending')
            break
          if (act?.status === 'closed') {
            buffer = buffer.slice(act.length)
            await onSpecial(act.special)
            inTag = false
            continue
          }

          const closeTagIndex = buffer.indexOf(TAG_CLOSE)
          if (closeTagIndex < 0)
            break

          const emit = buffer.slice(0, closeTagIndex + TAG_CLOSE.length)
          buffer = buffer.slice(closeTagIndex + TAG_CLOSE.length)
          await onSpecial(emit)
          inTag = false
        }
      }
    },

    async end(onLiteral: (value: string) => Promise<void> | void) {
      if (!inTag && buffer.length > 0) {
        await onLiteral(buffer)
        buffer = ''
      }
    },
  }
}

function createLlmMarkerStream(input: ReadableStream<string>, options?: MarkerParserOptions) {
  const { stream, write, close, error } = createPushStream<MarkerToken>()
  const parser = createLlmMarkerParser(options)

  void readStream(input, async (chunk) => {
    await parser.consume(
      chunk,
      async (literal) => {
        if (!literal)
          return
        write({ type: 'literal', value: literal })
      },
      async (special) => {
        write({ type: 'special', value: special })
      },
    )
  })
    .then(async () => {
      await parser.end(async (literal) => {
        if (!literal)
          return
        write({ type: 'literal', value: literal })
      })
      close()
    })
    .catch((err) => {
      error(err)
    })

  return stream
}

/**
 * Creates a streaming parser for LLM responses with AIRI special markers.
 *
 * Use when:
 * - Handling streamed model output that may contain `<|...|>` markers.
 * - Literal text and special marker tokens need to be emitted separately.
 *
 * Expects:
 * - Callers feed chunks in order and call `end()` once the model stream ends.
 *
 * Returns:
 * - A parser with `consume()` and `end()` methods.
 */
export function useLlmmarkerParser(options: {
  onLiteral?: (literal: string) => void | Promise<void>
  onSpecial?: (special: string) => void | Promise<void>
  /**
   * Called when parsing ends with the full accumulated text.
   * Useful for final processing like categorization or filtering.
   */
  onEnd?: (fullText: string) => void | Promise<void>
  /**
   * The minimum length of text required to emit a literal part.
   * Useful for avoiding emitting literal parts too fast.
   */
  minLiteralEmitLength?: number
}) {
  let fullText = ''
  const { stream, write, close } = createPushStream<string>()

  const markerStream = createLlmMarkerStream(stream, { minLiteralEmitLength: options.minLiteralEmitLength })

  const processing = readStream(markerStream, async (token) => {
    if (token.type === 'literal')
      await options.onLiteral?.(token.value)
    if (token.type === 'special')
      await options.onSpecial?.(token.value)
  })

  return {
    /**
     * Consumes a chunk of text from the stream.
     *
     * @param textPart The chunk of text to consume.
     */
    async consume(textPart: string) {
      fullText += textPart
      write(textPart)
    },

    /**
     * Finalizes the parsing process.
     * Any remaining content in the buffer is flushed as a final literal part.
     */
    async end() {
      close()
      await processing
      await options.onEnd?.(fullText)
    },
  }
}
