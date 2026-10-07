import type { WireMessage } from './wire'

/**
 * Measured on 2026-10-07 with Gemini `countTokens`: English prose and compact JSON take 3.5 to 4.4 characters
 * per token, and Japanese takes 1.76. The values below sit on the safe side of those numbers, because an
 * estimate that is too low sends a request that the provider then rejects with a 429.
 */
const LATIN_CHARS_PER_TOKEN = 3.4
const CJK_TOKENS_PER_CHAR = 0.65
/** Accented letters, Cyrillic, symbols, and the halves of surrogate pairs such as emoji. */
const OTHER_TOKENS_PER_UNIT = 0.5
/** Role, separators, and the other framing tokens that each message adds. */
const MESSAGE_OVERHEAD_TOKENS = 4
const TOOL_CALL_OVERHEAD_TOKENS = 8
/** Gemini images cost 258 to 1120 tokens and Groq vision costs 2048. The default sits on the Gemini side. */
const DEFAULT_IMAGE_TOKENS = 1100
/** Audio parts carry base64 data. About 25 tokens per second of 16 kHz 16-bit mono audio. */
const AUDIO_TOKENS_PER_BASE64_CHAR = 25 / (32_000 / 0.75)
const MAX_UNKNOWN_PART_CHARS = 4000

export interface TokenEstimatorOptions {
  /**
   * Ratio of the tokens that a provider reported to the tokens that the base estimate predicted.
   * The ledger learns it from `usage.prompt_tokens`.
   *
   * @default 1
   */
  calibration?: number
  /**
   * Tokens that one image costs on the target model.
   *
   * @default 1100
   */
  imageTokens?: number
}

export interface TokenEstimator {
  readonly imageTokens: number
  text: (text: string) => number
  /** Counts message content: a string, or an array of text, image, and audio parts. */
  content: (content: unknown) => number
  message: (message: WireMessage) => number
  /** Counts a JSON value in its compact serialization. Use it for tool schemas. */
  json: (value: unknown) => number
}

/**
 * Creates a character-class token estimator.
 *
 * It runs without a tokenizer, so the cost stays at microseconds for a 50k-token request.
 * Image data URIs are never read. An image costs a fixed amount, however large its base64 text is.
 *
 * @example
 * const estimator = createTokenEstimator()
 * estimator.text('hello world')
 * // => 4
 */
export function createTokenEstimator(options: TokenEstimatorOptions = {}): TokenEstimator {
  const calibration = options.calibration ?? 1
  const imageTokens = options.imageTokens ?? DEFAULT_IMAGE_TOKENS

  function text(value: string): number {
    if (!value)
      return 0
    let latin = 0
    let cjk = 0
    let other = 0
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i)
      if (code < 0x250)
        latin++
      else if (isCjkUnit(code))
        cjk++
      else
        other++
    }
    return Math.ceil((latin / LATIN_CHARS_PER_TOKEN + cjk * CJK_TOKENS_PER_CHAR + other * OTHER_TOKENS_PER_UNIT) * calibration)
  }

  function part(value: unknown): number {
    if (typeof value === 'string')
      return text(value)
    if (!value || typeof value !== 'object')
      return 0
    const record = value as Record<string, unknown>
    switch (record.type) {
      case 'text':
      case 'input_text':
      case 'output_text':
        return typeof record.text === 'string' ? text(record.text) : 0
      case 'image_url':
      case 'input_image':
      case 'image':
        return imageTokens
      case 'input_audio': {
        const data = (record.input_audio as { data?: unknown } | undefined)?.data
        return Math.ceil(typeof data === 'string' ? data.length * AUDIO_TOKENS_PER_BASE64_CHAR : 0)
      }
      default:
        return text(JSON.stringify(record).slice(0, MAX_UNKNOWN_PART_CHARS))
    }
  }

  function content(value: unknown): number {
    if (value === null || value === undefined)
      return 0
    if (Array.isArray(value))
      return value.reduce<number>((sum, item) => sum + part(item), 0)
    return part(value)
  }

  function message(value: WireMessage): number {
    let tokens = MESSAGE_OVERHEAD_TOKENS + content(value.content)
    for (const call of value.tool_calls ?? [])
      tokens += TOOL_CALL_OVERHEAD_TOKENS + text(call.function?.name ?? '') + text(call.function?.arguments ?? '')
    if (typeof value.name === 'string')
      tokens += text(value.name)
    return tokens
  }

  return {
    imageTokens,
    text,
    content,
    message,
    json: value => text(JSON.stringify(value) ?? ''),
  }
}

/** Fullwidth forms, CJK symbols, kana, CJK ideographs, and Hangul syllables. */
function isCjkUnit(code: number): boolean {
  return (code >= 0x3000 && code <= 0x30FF)
    || (code >= 0x3400 && code <= 0x4DBF)
    || (code >= 0x4E00 && code <= 0x9FFF)
    || (code >= 0xAC00 && code <= 0xD7AF)
    || (code >= 0xFF00 && code <= 0xFFEF)
}
