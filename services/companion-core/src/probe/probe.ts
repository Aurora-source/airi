import type { ResolvedModel } from '../config/config'
import type { ObservedLimits } from '../quota/rate-limit'

import { errorMessageFrom } from '@moeru/std'

import { createRedactor } from '../logging/redact'
import { sendChatCompletion } from '../providers/openai-compatible'
import { parseRateLimitHeaders } from '../quota/rate-limit'
import { solidColorPng } from './png'

/**
 * What a live probe measured for one model. The router trusts it over the configuration, because a document can be
 * out of date and a model name can be gone. `failures` holds one short reason per failed test, with every key removed.
 */
export interface ProbeResult {
  modelId: string
  probedAtMs: number
  /** The provider answered over HTTP. */
  reachable: boolean
  /**
   * A plain chat request succeeded. The capability fields mean something only when this is true,
   * because a bad key or a dead endpoint says nothing about what the model supports.
   */
  working: boolean
  /** The model list names the model. Absent when the provider has no model list. */
  exists?: boolean
  streaming: boolean
  tools: boolean
  /** The streamed tool-call fragments had no `index`. The provider needs `compat: gemini`, or an adapter like it. */
  toolCallIndexMissing: boolean
  images: boolean
  structuredOutput: boolean
  /** Time to the first body byte of the streaming test. */
  firstByteMs?: number
  totalMs?: number
  rateLimit?: ObservedLimits
  /** The largest prompt that a deep probe sent successfully. */
  maxAcceptedPromptTokens?: number
  /**
   * A deep probe was refused because the prompt exceeded the context of the model.
   * A refusal by a per-minute token limit does not count, because that limit is a rate and the quota ledger handles it.
   */
  contextLimitFound?: boolean
  failures: Record<string, string>
}

export interface ProbeOptions {
  apiKey?: string
  now?: () => number
  /** Limit for each request. */
  timeoutMs?: number
  /**
   * Send growing prompts to find the largest one that the provider accepts. This costs quota, so it is opt-in.
   * The steps run in order and stop at the first failure.
   */
  deep?: { stepsTokens: number[] }
}

const DEFAULT_TIMEOUT_MS = 30_000
const WEATHER_TOOL = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Gets the current weather of a city.',
    parameters: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'], additionalProperties: false },
  },
}
/** A flat red image. Any vision model can say that it is red. */
const RED_PNG = solidColorPng(32, 32, [255, 0, 0])
const STRUCTURED_FORMAT = {
  type: 'json_schema',
  json_schema: { name: 'probe', strict: true, schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } },
}
const FILLER_SENTENCE = 'The quick brown fox jumps over the lazy dog while the moon rises over the quiet harbor. '

/**
 * Tests one model against its provider and returns what works.
 *
 * Tests, in order: the model list, a plain request, a streamed request, a tool call, an image, structured output, and
 * (when asked) the largest prompt. A provider that does not answer at all ends the probe early. Each test sends a tiny request,
 * except the deep test.
 */
export async function probeModel(model: ResolvedModel, options: ProbeOptions = {}): Promise<ProbeResult> {
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const redact = createRedactor(options.apiKey ? [options.apiKey] : [])
  const result: ProbeResult = {
    modelId: model.id,
    probedAtMs: now(),
    reachable: false,
    working: false,
    streaming: false,
    tools: false,
    toolCallIndexMissing: false,
    images: false,
    structuredOutput: false,
    failures: {},
  }

  const post = async (body: Record<string, unknown>) => {
    const started = performance.now()
    const response = await sendChatCompletion({
      provider: model.provider,
      apiKey: options.apiKey,
      body: JSON.stringify({ model: model.model, ...body }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    result.rateLimit ??= parseRateLimitHeaders(response.headers, now())
    return { response, started }
  }
  const failure = async (name: string, response: Response) => {
    result.failures[name] = `HTTP ${response.status}: ${redact(await errorTextOf(response))}`
  }

  result.exists = await listsModel(model, options.apiKey, timeoutMs)

  // The plain request decides whether the provider and the key work at all.
  try {
    const { response } = await post({ messages: [{ role: 'user', content: 'Reply with the single word: pong' }], max_tokens: 32 })
    result.reachable = true
    if (!response.ok) {
      await failure('basic', response)
      return result
    }
    await response.arrayBuffer()
    result.working = true
  }
  catch (error) {
    result.failures.reachable = redact(errorTextOfThrown(error))
    return result
  }

  await attempt('streaming', async () => {
    const { response, started } = await post({ stream: true, messages: [{ role: 'user', content: 'Reply with the single word: pong' }], max_tokens: 32 })
    if (!response.ok)
      return failure('streaming', response)
    const text = await readStreamed(response, (firstByteAt) => {
      result.firstByteMs = Math.round(firstByteAt - started)
    })
    result.totalMs = Math.round(performance.now() - started)
    result.streaming = (response.headers.get('content-type') ?? '').includes('text/event-stream') && text.includes('data:')
    if (!result.streaming)
      result.failures.streaming = 'the response was not an event stream'
  })

  await attempt('tools', async () => {
    const ask = (toolChoice: string) => post({
      stream: true,
      messages: [{ role: 'user', content: 'What is the weather in Osaka right now? Use the get_weather tool.' }],
      tools: [WEATHER_TOOL],
      tool_choice: toolChoice,
      max_tokens: 200,
    })
    let { response } = await ask('auto')
    if (!response.ok)
      return failure('tools', response)
    let calls = toolCallsOf(await readStreamed(response))
    if (calls.length === 0) {
      // A model can answer in text when the choice is automatic. Insist once, to tell "cannot" from "chose not to".
      ;({ response } = await ask('required'))
      if (!response.ok)
        return failure('tools', response)
      calls = toolCallsOf(await readStreamed(response))
    }
    result.tools = calls.some(call => call.name === 'get_weather')
    result.toolCallIndexMissing = calls.some(call => call.index === undefined)
    if (!result.tools)
      result.failures.tools = 'the model did not call the tool'
  })

  await attempt('images', async () => {
    const { response } = await post({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'What color is this image? Answer with one word.' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${RED_PNG}` } }] }],
      max_tokens: 32,
    })
    if (!response.ok)
      return failure('images', response)
    // The model must name the color. A reply such as "I cannot see an image" is not vision.
    result.images = /red/i.test(contentOf(await response.json()))
    if (!result.images)
      result.failures.images = 'the model did not name the color of the image'
  })

  await attempt('structured', async () => {
    const { response } = await post({
      messages: [{ role: 'user', content: 'Return the JSON object with ok set to true.' }],
      response_format: STRUCTURED_FORMAT,
      max_tokens: 64,
    })
    if (!response.ok)
      return failure('structured', response)
    try {
      result.structuredOutput = typeof JSON.parse(contentOf(await response.json())).ok === 'boolean'
    }
    catch {
      result.structuredOutput = false
    }
    if (!result.structuredOutput)
      result.failures.structured = 'the reply was not the JSON object that the schema asks for'
  })

  if (options.deep) {
    for (const stepTokens of options.deep.stepsTokens) {
      let accepted = false
      await attempt('context', async () => {
        const text = FILLER_SENTENCE.repeat(Math.ceil((stepTokens * 3.4) / FILLER_SENTENCE.length)).slice(0, Math.round(stepTokens * 3.4))
        const { response } = await post({ messages: [{ role: 'user', content: `${text}\n\nReply with the single word: pong` }], max_tokens: 16 })
        if (!response.ok) {
          const message = redact(await errorTextOf(response))
          // Groq refuses a large prompt with "tokens per minute". That is a rate limit, and it says nothing about the context window.
          const rateBound = response.status === 429 || /per minute|\bTPM\b|rate limit|quota/i.test(message)
          result.contextLimitFound = !rateBound
          result.failures.context = `rejected at ${stepTokens} tokens, HTTP ${response.status}${rateBound ? ' (a rate limit, not the context window)' : ''}: ${message}`
          return
        }
        await response.arrayBuffer()
        result.maxAcceptedPromptTokens = stepTokens
        accepted = true
      })
      if (!accepted)
        break
    }
  }

  /** One test must not stop the others. A throw is recorded as that test's failure. */
  async function attempt(name: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await run()
    }
    catch (error) {
      result.failures[name] = redact(errorTextOfThrown(error))
    }
  }

  return result
}

async function listsModel(model: ResolvedModel, apiKey: string | undefined, timeoutMs: number): Promise<boolean | undefined> {
  try {
    const response = await fetch(new URL('models', model.provider.baseURL), {
      headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok)
      return undefined
    const body = await response.json() as { data?: { id?: string }[], models?: { name?: string }[] }
    const ids = [...(body.data ?? []).map(entry => entry.id), ...(body.models ?? []).map(entry => entry.name)].filter((id): id is string => typeof id === 'string')
    return ids.some(id => id === model.model || id === `models/${model.model}`)
  }
  catch {
    return undefined
  }
}

/** Reads a whole event stream into text. `onFirstByte` receives the time of the first chunk. */
async function readStreamed(response: Response, onFirstByte?: (at: number) => void): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  let first = true
  for await (const chunk of response.body ?? []) {
    if (first) {
      onFirstByte?.(performance.now())
      first = false
    }
    text += decoder.decode(chunk, { stream: true })
  }
  return text + decoder.decode()
}

/** Tool-call fragments of a streamed response, by name, with the `index` as the provider sent it. */
function toolCallsOf(stream: string): { name?: string, index?: number }[] {
  const calls: { name?: string, index?: number }[] = []
  for (const line of stream.split(/\r?\n/)) {
    if (!line.startsWith('data:') || line.includes('[DONE]'))
      continue
    try {
      const event = JSON.parse(line.slice(5)) as { choices?: { delta?: { tool_calls?: { index?: number, function?: { name?: string } }[] } }[] }
      for (const choice of event.choices ?? []) {
        for (const call of choice.delta?.tool_calls ?? [])
          calls.push({ name: call.function?.name, index: call.index })
      }
    }
    catch {
      // A partial line is not an event. The next chunk completes it, and the test only needs complete events.
    }
  }
  return calls.filter(call => call.name !== undefined || call.index !== undefined)
}

function contentOf(body: unknown): string {
  const content = (body as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content
  return typeof content === 'string' ? content : ''
}

async function errorTextOf(response: Response): Promise<string> {
  const text = (await response.text()).slice(0, 2000)
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } } | { error?: { message?: string } }[]
    const message = (Array.isArray(parsed) ? parsed[0] : parsed)?.error?.message
    if (typeof message === 'string')
      return message.slice(0, 200)
  }
  catch {
    // A body that is not JSON is shown as text.
  }
  return text.replace(/\s+/g, ' ').slice(0, 200)
}

function errorTextOfThrown(error: unknown): string {
  const cause = (error as { cause?: { message?: string } }).cause?.message
  return `${errorMessageFrom(error) ?? String(error)}${cause ? ` (${cause})` : ''}`.slice(0, 200)
}
