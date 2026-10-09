import type { InjectedUnit } from '../../src/budget/budgeter'
import type { WireRequest } from '../../src/budget/wire'
import type { CompanionConfig } from '../../src/config/config'
import type { RunningGateway } from '../../src/server'
import type { Model, StreamResult } from './protocol'

import { randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseConfig } from '../../src/config/config'
import { prepareGeminiRequest } from '../../src/providers/gemini-compat'
import { startGateway } from '../../src/server'
import { costNano, parseUsage, SpendLedger } from './accounting'
import { ACT_REMINDER, fingerprint, PRICES } from './corpus'
import { StreamMeter } from './protocol'

export type Path = 'direct' | 'gateway-baseline' | 'gateway-paid' | 'gateway-optimized'

export interface Sample extends StreamResult {
  id: string
  model: string
  path: Path
  scenario: string
  cold: boolean
  at: string
  requestSha256: string
  preparationMs: number
  headersMs: number
  contextAssemblyMs?: number
  providerSelectionAndBudgetMs?: number
  gatewayProviderFirstByteMs?: number
  gatewayBeforeProviderMs?: number
  prompt?: unknown
  status: number
  costNano?: number
  error?: string
  maxTokens: number
  reasoningEffort?: string
  campaignRunId?: string
}

/** Reproduces repository fixture limits or uses discovered capacities with no stale quota or probe state. Provider quotas remain externally enforced. */
export function configuration(models: Model[], paid: boolean, baseURL = 'https://generativelanguage.googleapis.com/v1beta/openai/', reminder = false): CompanionConfig {
  const selected = models.filter(model => PRICES[model.name.replace('models/', '')])
  return parseConfig({
    port: 0,
    profile: 'cloud',
    store: { path: ':memory:' },
    memory: { enabled: false },
    channel: { enabled: false },
    perception: { enabled: false },
    watch: { enabled: false },
    providers: { gemini: { baseURL, keyRef: 'provider-gemini', compat: 'gemini', locality: 'cloud' } },
    models: Object.fromEntries(selected.map((model) => {
      const id = model.name.replace('models/', '')
      return [id, {
        provider: 'gemini',
        model: id,
        ...(reminder ? { styleReminder: ACT_REMINDER } : {}),
        capabilities: { contextWindow: paid ? model.inputTokenLimit : 1_000_000, maxOutput: paid ? model.outputTokenLimit : 8192, tools: true, images: true, structuredOutput: true, imageTokens: 1100 },
        limits: paid ? {} : { rpm: 15, rpd: 500, tpm: 250_000, dayReset: { timeZone: 'America/Los_Angeles' } },
      }]
    })),
    // A single model per alias bounds live attempts. Deterministic regressions cover multi-provider failover separately.
    aliases: Object.fromEntries(selected.map(model => [`bench-${model.name.replace('models/', '')}`, { chain: [model.name.replace('models/', '')], ...(paid ? { prompt: { softTarget: 60_000, expandedTarget: 80_000, maxTarget: 100_000 } } : {}) }])),
  })
}

/** Isolated direct-provider and existing Gateway measurements, with one reservation per possible paid attempt. */
export class Benchmark {
  readonly ledger: SpendLedger
  private readonly gateways = new Map<Path, Promise<RunningGateway>>()
  private readonly units = new Map<string, readonly InjectedUnit[]>()
  private readonly timings = new Map<string, { contextAssemblyMs: number, providerSelectionAndBudgetMs?: number }>()
  private readonly bodies = new WeakMap<WireRequest, string>()
  private readonly active = new Set<string>()
  private readonly overlapping = new Set<string>()
  private readonly inference = `cc_inf_${randomBytes(32).toString('hex')}`
  private readonly ops = `cc_ops_${randomBytes(32).toString('hex')}`

  /** @default budget.ceilingNano 4,500,000,000. @default budget.concurrency 2. */
  constructor(private readonly directory: string, private readonly key: string, private readonly models: Model[], private readonly baseURL = 'https://generativelanguage.googleapis.com/v1beta/openai/', budget: { ceilingNano?: number, concurrency?: number } = {}) {
    this.ledger = new SpendLedger(join(directory, 'ledger.json'), budget.ceilingNano, budget.concurrency)
  }

  /** One final usage record settles one reservation. Missing usage retains exposure and halts subsequent dispatch. No automatic live retries. */
  async request(input: { model: string, path: Path, scenario: string, body: WireRequest, cold?: boolean, units?: InjectedUnit[], transport?: typeof fetch, signal?: AbortSignal, campaignRunId?: string }): Promise<Sample> {
    const preparedAt = performance.now()
    const allowed = new Set(['model', 'messages', 'tools', 'tool_choice', 'stream', 'stream_options', 'max_tokens', 'n', 'temperature', 'reasoning_effort', 'response_format'])
    if (Object.keys(input.body).some(name => !allowed.has(name)))
      throw new Error('Unsupported request override or generation limit')
    const model = this.models.find(model => model.name === `models/${input.model}`)
    const price = PRICES[input.model]
    if (!model || !price)
      throw new Error('Model availability or pricing is unknown')
    const output = input.body.max_tokens
    if (typeof output !== 'number' || !Number.isSafeInteger(output) || output < 1 || output > Math.min(8192, model.outputTokenLimit))
      throw new Error('A bounded output limit is required')
    if (input.body.n !== undefined && input.body.n !== 1)
      throw new Error('Only one generation candidate is allowed')
    if (input.body.tools?.some(tool => typeof tool !== 'object' || tool === null || (tool as { type?: unknown }).type !== 'function'))
      throw new Error('Only local synthetic function tools are priced by this harness')
    const id = randomUUID()
    const body = prepareGeminiRequest({ ...input.body, model: input.path === 'direct' ? input.model : `bench-${input.model}`, n: 1, stream: true, stream_options: { include_usage: true } })
    if (input.path === 'direct' && input.units?.length)
      body.messages = [...(body.messages ?? []).slice(0, -1), ...input.units.map(unit => unit.message), ...(body.messages ?? []).slice(-1)]
    const wire = JSON.stringify(body)
    // Reserve the entire advertised input window. A tokenizer estimate cannot provide a strict financial bound.
    // Google's output limit covers generated text and thinking together. No paid server tools are enabled.
    const inputBound = model.inputTokenLimit
    const gateway = input.path === 'direct' ? undefined : await this.gateway(input.path)
    this.units.set(id, input.units ?? [])
    this.ledger.reserve(id, input.model, price, inputBound, output)
    for (const other of this.active) {
      this.overlapping.add(other)
      this.overlapping.add(id)
    }
    this.active.add(id)
    const preparationMs = performance.now() - preparedAt
    const started = performance.now()
    const meter = new StreamMeter()
    let status = 0
    let headersMs = 0
    let failure: string | undefined
    let measured: StreamResult | undefined
    try {
      const url = new URL('chat/completions', gateway?.baseURL ?? this.baseURL)
      const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000)
      const response = await (input.transport ?? fetch)(url, {
        method: 'POST',
        headers: { 'authorization': `Bearer ${gateway ? this.inference : this.key}`, 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'accept-encoding': 'identity', ...(gateway ? { 'x-airi-round-id': id, 'x-airi-session-id': 'synthetic-benchmark', 'x-airi-character-id': 'synthetic-mura' } : {}) },
        body: wire,
        signal,
      })
      status = response.status
      headersMs = performance.now() - started
      if (!response.ok || !response.body) {
        if (response.body) {
          const value: unknown = await response.json()
          if (value && typeof value === 'object' && 'usage' in value)
            measured = { text: '', calls: [], totalMs: performance.now() - started, done: false, missingIndices: 0, reasoningChannel: false, usage: parseUsage(value.usage), reportedUsage: value.usage }
        }
        throw new Error('HTTP failure or missing response body')
      }
      for await (const bytes of response.body)
        meter.push(bytes, performance.now() - started)
      measured = meter.finish(performance.now() - started)
      if (!measured.done)
        throw new Error('Stream has no completion marker')
    }
    catch {
      failure = input.signal?.aborted ? 'cancelled' : 'http-network-or-stream-failure'
    }
    const result = measured ?? { text: '', calls: [], totalMs: performance.now() - started, done: false, missingIndices: 0, reasoningChannel: false }
    const timings = this.timings.get(id)
    // Route records have no round ID. Omit them for overlapping requests and never use them to release monetary exposure.
    const route = this.overlapping.has(id) ? undefined : gateway?.runtime.recentRoutes().findLast(route => route.alias === body.model)
    const usage = result.usage
    this.ledger.settle(id, usage)
    const sample: Sample = {
      ...result,
      id,
      model: input.model,
      path: input.path,
      scenario: input.scenario,
      cold: input.cold === true,
      at: new Date().toISOString(),
      requestSha256: fingerprint({ body: input.body, units: input.units }),
      preparationMs,
      headersMs,
      maxTokens: output,
      reasoningEffort: typeof input.body.reasoning_effort === 'string' ? input.body.reasoning_effort : undefined,
      campaignRunId: input.campaignRunId,
      ...timings,
      gatewayProviderFirstByteMs: route?.firstByteMs,
      gatewayBeforeProviderMs: result.firstByteMs !== undefined && route?.firstByteMs !== undefined ? result.firstByteMs - route.firstByteMs : undefined,
      prompt: route?.prompt,
      status,
      costNano: usage ? costNano(price, usage) : undefined,
      error: failure,
    }
    appendFileSync(join(this.directory, 'samples.ndjson'), `${JSON.stringify(sample)}\n`)
    this.units.delete(id)
    this.timings.delete(id)
    this.active.delete(id)
    this.overlapping.delete(id)
    if (!usage || failure)
      throw new Error('Campaign stopped after uncertain usage or unsuccessful delivery')
    return sample
  }

  private gateway(path: Path): Promise<RunningGateway> {
    let started = this.gateways.get(path)
    if (started)
      return started
    started = startGateway({
      config: configuration(this.models, path !== 'gateway-baseline', this.baseURL, path === 'gateway-optimized'),
      credentials: { inference: this.inference, ops: this.ops },
      providerKeys: new Map([['provider-gemini', this.key]]),
      writeLog: () => {},
      companion: { begin: async (request) => {
        const at = performance.now()
        const id = request.headers['x-airi-round-id']
        if (typeof id !== 'string')
          return undefined
        this.bodies.set(request.body, id)
        const units = this.units.get(id)
        this.timings.set(id, { contextAssemblyMs: performance.now() - at })
        return { units: units ?? [], finish: () => {} }
      } },
    }).then((gateway) => {
      const plan = gateway.runtime.router.plan.bind(gateway.runtime.router)
      // Instrument this isolated runtime instance. Production methods and other worktrees remain unchanged.
      gateway.runtime.router.plan = (body, units) => {
        const at = performance.now()
        const result = plan(body, units)
        const timing = this.timings.get(this.bodies.get(body) ?? '')
        if (timing)
          timing.providerSelectionAndBudgetMs = performance.now() - at
        return result
      }
      return gateway
    })
    this.gateways.set(path, started)
    return started
  }

  async close(): Promise<void> {
    try {
      for (const gateway of this.gateways.values())
        await (await gateway).close()
    }
    finally {
      this.ledger.close()
    }
  }
}
