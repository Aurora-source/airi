import type { WireToolCall } from '../../src/budget/wire'
import type { Usage } from './accounting'

import * as v from 'valibot'

import { parseUsage } from './accounting'

/** Public model metadata returned by this key's native Gemini model-list endpoint. */
export interface Model {
  name: string
  inputTokenLimit: number
  outputTokenLimit: number
  supportedGenerationMethods: string[]
}

/** Lists metadata without generation. The key travels in a header and never appears in returned data or URLs. */
export async function discover(key: string, transport: typeof fetch = fetch): Promise<Model[]> {
  const models: Model[] = []
  const pages = new Set<string>()
  let page = ''
  do {
    if (pages.has(page) || pages.size >= 10)
      throw new Error('Unexpected model-list pagination')
    pages.add(page)
    const url = new URL('https://generativelanguage.googleapis.com/v1beta/models')
    url.searchParams.set('pageSize', '1000')
    if (page)
      url.searchParams.set('pageToken', page)
    const response = await transport(url, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(30_000) })
    if (!response.ok)
      throw new Error(`Model discovery HTTP ${response.status}`)
    const parsed = v.parse(v.object({
      models: v.array(v.looseObject({
        name: v.pipe(v.string(), v.regex(/^models\/[a-z0-9.-]+$/)),
        inputTokenLimit: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1))),
        outputTokenLimit: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1))),
        supportedGenerationMethods: v.array(v.string()),
      })),
      nextPageToken: v.optional(v.string()),
    }), await response.json())
    for (const model of parsed.models) {
      if (!model.supportedGenerationMethods.includes('generateContent'))
        continue
      if (model.inputTokenLimit === undefined || model.outputTokenLimit === undefined)
        throw new Error(`Incomplete generation limits for ${model.name}`)
      models.push({ name: model.name, inputTokenLimit: model.inputTokenLimit, outputTokenLimit: model.outputTokenLimit, supportedGenerationMethods: model.supportedGenerationMethods })
    }
    page = parsed.nextPageToken ?? ''
  } while (page)
  return models
}

export interface StreamResult {
  text: string
  calls: WireToolCall[]
  usage?: Usage
  reportedUsage?: unknown
  textChunks?: { text: string, atMs: number }[]
  firstByteMs?: number
  firstTextMs?: number
  firstSentenceMs?: number
  firstToolMs?: number
  totalMs: number
  done: boolean
  missingIndices: number
  reasoningChannel: boolean
  finishReason?: string
}

const eventSchema = v.looseObject({
  error: v.optional(v.unknown()),
  usage: v.optional(v.nullable(v.unknown())),
  choices: v.optional(v.array(v.looseObject({
    index: v.optional(v.number()),
    finish_reason: v.optional(v.nullable(v.string())),
    delta: v.optional(v.looseObject({
      content: v.optional(v.nullable(v.string())),
      reasoning_content: v.optional(v.nullable(v.string())),
      tool_calls: v.optional(v.array(v.looseObject({
        index: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
        id: v.optional(v.string()),
        type: v.optional(v.string()),
        function: v.optional(v.object({ name: v.optional(v.string()), arguments: v.optional(v.string()) })),
        extra_content: v.optional(v.unknown()),
      }))),
    })),
  }))),
})

/** Owns one stream's decoder, event buffer, tool fragments, and timing markers. Times are milliseconds since request dispatch. */
export class StreamMeter {
  private readonly decoder = new TextDecoder()
  private pending = ''
  private readonly tools = new Map<number, WireToolCall>()
  private lastTool = 0
  private generationVersion = 0
  private usageVersion = -1
  private readonly result: StreamResult = { text: '', calls: [], totalMs: 0, done: false, missingIndices: 0, reasoningChannel: false }

  push(bytes: Uint8Array, at: number): void {
    if (bytes.length && this.result.firstByteMs === undefined)
      this.result.firstByteMs = at
    this.pending += this.decoder.decode(bytes, { stream: true })
    if (this.pending.length > 2 * 1024 * 1024)
      throw new Error('Stream event exceeds measurement buffer')
    this.events(at)
  }

  finish(at: number): StreamResult {
    this.pending += this.decoder.decode()
    this.events(at)
    if (this.pending.trim())
      throw new Error('Interrupted SSE event')
    if (!this.result.done || this.usageVersion !== this.generationVersion) {
      this.result.usage = undefined
      this.result.reportedUsage = undefined
    }
    this.result.totalMs = at
    this.result.calls = [...this.tools.values()]
    return this.result
  }

  private events(at: number): void {
    for (let boundary = /\r?\n\r?\n/.exec(this.pending); boundary; boundary = /\r?\n\r?\n/.exec(this.pending)) {
      const event = this.pending.slice(0, boundary.index)
      this.pending = this.pending.slice(boundary.index + boundary[0].length)
      const payload = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
      if (!payload)
        continue
      if (payload === '[DONE]') {
        this.result.done = true
        continue
      }
      if (this.result.done)
        throw new Error('Data arrived after stream completion')
      const parsed = v.parse(eventSchema, JSON.parse(payload))
      if (parsed.error)
        throw new Error('Provider reported a streaming error')
      for (const choice of parsed.choices ?? []) {
        if (choice.index !== undefined && choice.index !== 0)
          throw new Error('Multiple candidates are outside the benchmark cost contract')
        if (choice.finish_reason) {
          this.generationVersion++
          this.result.finishReason = choice.finish_reason
        }
        const delta = choice.delta
        if (!delta)
          continue
        if (delta.reasoning_content) {
          this.generationVersion++
          this.result.reasoningChannel = true
        }
        if (delta.content) {
          this.result.textChunks ??= []
          this.result.textChunks.push({ text: delta.content, atMs: at })
          this.generationVersion++
          this.result.text += delta.content
          const spoken = spokenText(this.result.text)
          if (this.result.firstTextMs === undefined && /[\p{L}\p{N}]/u.test(spoken))
            this.result.firstTextMs = at
          if (this.result.firstSentenceMs === undefined && /[.!?。！？](?:\s|$)/u.test(spoken))
            this.result.firstSentenceMs = at
        }
        for (const fragment of delta.tool_calls ?? []) {
          this.generationVersion++
          this.result.firstToolMs ??= at
          if (fragment.index === undefined)
            this.result.missingIndices++
          const known = fragment.id ? [...this.tools.entries()].find(([, call]) => call.id === fragment.id)?.[0] : undefined
          const index = fragment.index ?? known ?? (fragment.id ? this.tools.size : this.lastTool)
          this.lastTool = index
          let call = this.tools.get(index)
          if (!call) {
            if (!fragment.id)
              throw new Error('A new tool call has no correlation ID')
            call = { id: fragment.id, type: fragment.type ?? 'function', function: { name: '', arguments: '' } }
            this.tools.set(index, call)
          }
          if (fragment.function?.name)
            call.function!.name = fragment.function.name
          if (fragment.function?.arguments)
            call.function!.arguments += fragment.function.arguments
          if (fragment.extra_content !== undefined)
            call.extra_content = fragment.extra_content
        }
      }
      if (parsed.usage !== undefined && parsed.usage !== null) {
        const usage = parseUsage(parsed.usage)
        const previous = this.result.usage
        if (previous && (usage.input < previous.input || usage.output < previous.output || usage.thinking < previous.thinking || usage.cached < previous.cached))
          throw new Error('Decreasing usage is ambiguous')
        this.result.usage = usage
        this.result.reportedUsage = parsed.usage
        this.usageVersion = this.generationVersion
      }
    }
  }
}

export function spokenText(text: string): string {
  let spoken = ''
  let cursor = 0
  for (;;) {
    const open = text.indexOf('<|', cursor)
    if (open < 0)
      return spoken + text.slice(cursor)
    spoken += text.slice(cursor, open)
    const close = text.indexOf('|>', open + 2)
    if (close < 0)
      return spoken
    cursor = close + 2
  }
}

/** Empirical linear-interpolation quantiles. p90 needs ten samples and p95 needs twenty. These thresholds do not establish statistical robustness. */
export function summarize(samples: number[]) {
  if (!samples.length || samples.some(value => !Number.isFinite(value) || value < 0))
    throw new Error('Statistics need finite non-negative samples')
  const sorted = samples.toSorted((a, b) => a - b)
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length
  const quantile = (fraction: number) => {
    const position = (sorted.length - 1) * fraction
    const lower = Math.floor(position)
    return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower)
  }
  return {
    n: samples.length,
    min: sorted[0],
    max: sorted.at(-1)!,
    mean,
    p50: quantile(0.5),
    p90: samples.length >= 10 ? quantile(0.9) : undefined,
    p95: samples.length >= 20 ? quantile(0.95) : undefined,
    standardDeviation: samples.length > 1 ? Math.sqrt(samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (samples.length - 1)) : 0,
  }
}
