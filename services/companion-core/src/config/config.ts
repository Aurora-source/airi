import type { InferOutput } from 'valibot'

import process from 'node:process'

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import * as v from 'valibot'

/** The gateway holds provider keys, so it never listens outside this loopback address. */
export const LOOPBACK_HOST = '127.0.0.1'

const positiveInt = v.pipe(v.number(), v.integer(), v.minValue(1))

const providerSchema = v.object({
  /** Base URL of an OpenAI-compatible API, with a trailing slash, for example `https://api.groq.com/openai/v1/`. */
  baseURL: v.pipe(v.string(), v.url(), v.endsWith('/')),
  /** Name of the protected secret that holds this provider's API key. A local provider can run without a key. */
  keyRef: v.optional(v.pipe(v.string(), v.regex(/^[a-z0-9-]+$/))),
  /**
   * Provider-specific stream repair. Absent means byte-for-byte passthrough.
   * `gemini` adds the tool-call `index` that the Gemini OpenAI-compatible endpoint omits.
   */
  compat: v.optional(v.picklist(['gemini'])),
  /**
   * `local` marks inference on this machine, for example Ollama. A profile decides whether a chain can contain such a model.
   * The gateway never starts a local service. Companion Ops does.
   *
   * @default 'cloud'
   */
  locality: v.optional(v.picklist(['cloud', 'local']), 'cloud'),
})

const capabilitiesSchema = v.object({
  /** Context window of the model, in tokens. */
  contextWindow: positiveInt,
  /** Lower bound for the prompt size. It wins over the value that the context window and output limit imply. */
  maxPrompt: v.optional(positiveInt),
  /** Largest completion that the model produces. */
  maxOutput: v.optional(positiveInt, 8192),
  streaming: v.optional(v.boolean(), true),
  tools: v.optional(v.boolean(), true),
  images: v.optional(v.boolean(), false),
  structuredOutput: v.optional(v.boolean(), false),
  /** Tokens that one image costs on this model. Gemini costs about 258 to 1120, and Groq vision costs 2048. */
  imageTokens: v.optional(positiveInt),
})

const limitsSchema = v.object({
  rpm: v.optional(positiveInt),
  tpm: v.optional(positiveInt),
  rpd: v.optional(positiveInt),
  tpd: v.optional(positiveInt),
  /** Whether the provider counts only input tokens or input and output tokens against `tpm` and `tpd`. */
  tpmBasis: v.optional(v.picklist(['input', 'total']), 'input'),
  /**
   * When the daily counters reset. `rolling` counts the last 24 hours, which is the safe choice.
   * A time zone resets at local midnight, for example `America/Los_Angeles` for Gemini.
   */
  dayReset: v.optional(v.union([v.literal('rolling'), v.object({ timeZone: v.string() })]), 'rolling'),
})

const modelSchema = v.object({
  /** Key of one entry in `providers`. */
  provider: v.string(),
  /** Model name that the provider receives. */
  model: v.pipe(v.string(), v.minLength(1)),
  capabilities: capabilitiesSchema,
  /** Limits that the provider publishes. The ledger keeps what it observes next to them and never overwrites them. */
  limits: v.optional(limitsSchema, {}),
  /** A free label for diagnostics, for example the persona rank of the model. */
  quality: v.optional(v.string()),
  /**
   * A last instruction that the gateway adds to the end of the system prompt for this model only.
   * Use it for a format rule that the model breaks, for example the closing of ACT tokens. The benchmark shows whether it helps.
   */
  styleReminder: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(1200))),
})

const promptSchema = v.object({
  /** Normal prompt target in tokens. */
  softTarget: v.optional(positiveInt, 20_000),
  /** Target for a long conversation with much recent tool activity. */
  expandedTarget: v.optional(positiveInt, 30_000),
  /** Upper bound of the quality policy. A model's own limits still apply. */
  maxTarget: v.optional(positiveInt, 50_000),
  /** `auto` picks `softTarget`, and `expandedTarget` when tools were busy in recent turns. */
  mode: v.optional(v.picklist(['auto', 'soft', 'expanded', 'max']), 'auto'),
  /** Fraction of the target to trim down to when a request is over it. */
  lowWaterRatio: v.optional(v.pipe(v.number(), v.minValue(0.3), v.maxValue(1)), 0.85),
})

const ROLES = ['conversation', 'reasoning', 'vision', 'speech-recognition', 'speech-synthesis', 'embedding'] as const

/** Roles whose aliases serve `POST /v1/chat/completions`. A `speech-recognition` alias serves `POST /v1/audio/transcriptions`. */
const CHAT_COMPLETION_ROLES: ReadonlySet<string> = new Set(['conversation', 'reasoning', 'vision'])

const aliasSchema = v.object({
  /** The architecture capability that this alias serves. It decides which endpoint routes the alias. */
  role: v.optional(v.picklist(ROLES), 'conversation'),
  /** Keys of `models`, best first. The router walks this order, after stickiness and eligibility. */
  chain: v.pipe(v.array(v.string()), v.minLength(1)),
  prompt: v.optional(promptSchema, {}),
  /** Output tokens to reserve when a request sets no `max_tokens`. */
  outputReserveTokens: v.optional(positiveInt, 1024),
})

const routingSchema = v.object({
  /** A conversation that is idle for this long can move to the head of the chain again. */
  stickyIdleMinutes: v.optional(positiveInt, 360),
  /** Local hour of day, 0 to 23, at which every sticky choice resets. Absent means no daily reset. */
  stickyResetHour: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(23))),
  /** Time from sending a request to the first response byte. A provider that is slower is treated as failed before any output. */
  firstByteTimeoutMs: v.optional(positiveInt, 30_000),
  /** First cool-down after a network or server failure. It doubles for each further failure in a row. */
  failureCooldownMs: v.optional(positiveInt, 10_000),
  failureCooldownMaxMs: v.optional(positiveInt, 300_000),
  /** Factor on token estimates for the quota checks. The estimator can undercount a little. */
  tokenSafetyMargin: v.optional(v.pipe(v.number(), v.minValue(1)), 1.05),
  /** Tokens that a tool result adds to the second request of a tool turn. */
  toolResultReserveTokens: v.optional(positiveInt, 800),
  /** Whether a model that fits the first request of a tool turn, but not the second, can serve a request that probably needs no tool. */
  allowFirstRoundOnly: v.optional(v.boolean(), true),
})

const audioSchema = v.object({
  /** Largest accepted upload, multipart headers included. Groq accepts 25 MiB. */
  maxRequestBytes: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1024), v.maxValue(25 * 1024 * 1024)), 25 * 1024 * 1024),
  /** The provider response stays in memory until it is complete. */
  maxResponseBytes: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1024), v.maxValue(4 * 1024 * 1024)), 1024 * 1024),
  /** One deadline covers the upload, every fallback request, and the provider response. */
  timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(20), v.maxValue(120_000)), 15_000),
})

const memorySchema = v.object({
  /** Recall, injection, observation, and consolidation. The database stays on disk when this is off. */
  enabled: v.optional(v.boolean(), true),
  /** SQLite file. The default is `memory/companion-memory.sqlite` in the Core home. */
  path: v.optional(v.pipe(v.string(), v.minLength(1))),
  /** The one local user that owns this memory. No request or tool can name another user. */
  userId: v.optional(v.pipe(v.string(), v.regex(/^[\w.-]{1,64}$/)), 'local-user'),
  /** Recall deadline. It includes queue time. A late recall leaves the request without memory. */
  recallDeadlineMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(10), v.maxValue(1000)), 150),
  maxItems: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(5)), 5),
  /** UTF-8 bytes of the memory block, its labels included. */
  maxBytes: v.optional(v.pipe(v.number(), v.integer(), v.minValue(256), v.maxValue(8000)), 2400),
  /** Idle consolidation interval. Consolidation never runs inside a chat request. */
  consolidateEveryMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(10_000)), 300_000),
  consolidateBatch: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)), 20),
})

const channelSchema = v.object({
  /** Connects to AIRI's server channel, which reports persisted chat turns. Memory uses them as authoritative evidence. */
  enabled: v.optional(v.boolean(), true),
  url: v.optional(v.pipe(v.string(), v.regex(/^wss?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\//)), 'ws://localhost:6121/ws'),
  /** Name of the protected secret that holds the server channel token, when AIRI requires one. */
  tokenRef: v.optional(v.pipe(v.string(), v.regex(/^[a-z0-9-]+$/))),
})

const PROFILES = ['local', 'cloud', 'cloud-mura-voice', 'hybrid'] as const

const configSchema = v.pipe(
  v.object({
    host: v.optional(v.literal(LOOPBACK_HOST), LOOPBACK_HOST),
    /** Port 0 selects a free port. Tests use it. */
    port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(65535)), 11980),
    /**
     * Exact browser origins that can call the gateway. A request that sends any other `Origin` header is rejected.
     * Requests without an `Origin` header come from non-browser clients and only need the bearer token.
     */
    allowedOrigins: v.optional(v.array(v.pipe(v.string(), v.minLength(1))), []),
    /** Largest accepted request body. Inline base64 images make chat requests large. */
    maxRequestBytes: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1024)), 32 * 1024 * 1024),
    /**
     * Which models a chain can hold.
     * - `local`: local models only.
     * - `cloud` and `cloud-mura-voice`: cloud models only. Exhausted cloud quota is a visible error and never starts local inference.
     * - `hybrid`: cloud first, then local models that the chain lists explicitly after every cloud model.
     *
     * @default 'cloud-mura-voice'
     */
    profile: v.optional(v.picklist(PROFILES), 'cloud-mura-voice'),
    routing: v.optional(routingSchema, {}),
    /** Bounds of `POST /v1/audio/transcriptions`. The `speech-recognition` aliases choose its models. */
    audio: v.optional(audioSchema, {}),
    /** SQLite file for the quota ledger, sticky choices, and probe results. `:memory:` keeps them in memory. */
    store: v.optional(v.object({ path: v.optional(v.string()) }), {}),
    memory: v.optional(memorySchema, {}),
    channel: v.optional(channelSchema, {}),
    providers: v.record(v.string(), providerSchema),
    models: v.optional(v.record(v.string(), modelSchema), {}),
    aliases: v.record(v.string(), aliasSchema),
  }),
  v.rawCheck(({ dataset, addIssue }) => {
    if (!dataset.typed)
      return
    const config = dataset.value
    for (const [providerName, provider] of Object.entries(config.providers)) {
      if (provider.locality === 'cloud' && !provider.keyRef)
        addIssue({ message: `Provider "${providerName}" needs a keyRef, because it is a cloud provider.` })
    }
    for (const [modelId, model] of Object.entries(config.models)) {
      if (!(model.provider in config.providers))
        addIssue({ message: `Model "${modelId}" names unknown provider "${model.provider}".` })
    }
    for (const [aliasName, alias] of Object.entries(config.aliases)) {
      let sawLocal = false
      let reportedOrder = false
      for (const modelId of alias.chain) {
        const model = config.models[modelId]
        if (!model) {
          addIssue({ message: `Alias "${aliasName}" names unknown model "${modelId}".` })
          continue
        }
        const locality = config.providers[model.provider]?.locality
        if (!locality)
          continue
        if (config.profile === 'local' && locality === 'cloud')
          addIssue({ message: `Alias "${aliasName}": profile "local" does not allow the cloud model "${modelId}".` })
        if ((config.profile === 'cloud' || config.profile === 'cloud-mura-voice') && locality === 'local')
          addIssue({ message: `Alias "${aliasName}": profile "${config.profile}" does not allow the local model "${modelId}".` })
        if (config.profile === 'hybrid') {
          if (locality === 'local')
            sawLocal = true
          else if (sawLocal && !reportedOrder)
            reportedOrder = true
        }
      }
      if (config.profile === 'hybrid' && reportedOrder) {
        const firstLocal = alias.chain.find(id => config.providers[config.models[id]?.provider]?.locality === 'local')
        addIssue({ message: `Alias "${aliasName}": the local model "${firstLocal}" must come after every cloud model in a hybrid profile.` })
      }
    }
  }),
)

export type CompanionConfig = InferOutput<typeof configSchema>
export type ProviderConfig = CompanionConfig['providers'][string]
export type ModelEntry = CompanionConfig['models'][string]
export type ModelCapabilities = ModelEntry['capabilities']
export type ModelLimits = ModelEntry['limits']
export type AliasConfig = CompanionConfig['aliases'][string]
export type Profile = CompanionConfig['profile']
export type RoutingOptions = CompanionConfig['routing']
export type AudioLimits = CompanionConfig['audio']
export type MemoryOptions = CompanionConfig['memory']
export type ChannelOptions = CompanionConfig['channel']

/** Whether `POST /v1/chat/completions` can route this alias. */
export function servesChatCompletions(alias: AliasConfig): boolean {
  return CHAT_COMPLETION_ROLES.has(alias.role)
}

/** A chain entry with its provider joined in. The router and the executor work with this shape. */
export interface ResolvedModel {
  /** Key in `models`. */
  id: string
  providerName: string
  provider: ProviderConfig
  locality: ProviderConfig['locality']
  /** Model name that the provider receives. */
  model: string
  capabilities: ModelCapabilities
  limits: ModelLimits
  quality?: string
  styleReminder?: string
  /**
   * The quota scope: one key on one model. Providers meter limits per model and key, so the ledger counts per scope.
   * A local provider has no key, so its scope uses the provider name.
   */
  scope: string
}

/**
 * Validates a raw configuration object.
 *
 * Throws when the host is not loopback, a chain names an unknown model, the profile forbids a model, or a field is malformed.
 */
export function parseConfig(input: unknown): CompanionConfig {
  const result = v.safeParse(configSchema, input)
  if (!result.success)
    throw new Error(`Invalid companion-core configuration: ${v.summarize(result.issues)}`)
  return result.output
}

/** Joins one model entry with its provider. Returns `undefined` for an unknown id. */
export function resolveModel(config: CompanionConfig, modelId: string): ResolvedModel | undefined {
  const entry = config.models[modelId]
  const provider = entry && config.providers[entry.provider]
  if (!entry || !provider)
    return undefined
  return {
    id: modelId,
    providerName: entry.provider,
    provider,
    locality: provider.locality,
    model: entry.model,
    capabilities: entry.capabilities,
    limits: entry.limits,
    quality: entry.quality,
    styleReminder: entry.styleReminder,
    scope: `${provider.keyRef ?? entry.provider}|${entry.model}`,
  }
}

/** The chain of an alias, best first. Returns `undefined` for an unknown alias. */
export function resolveAlias(config: CompanionConfig, aliasName: string): ResolvedModel[] | undefined {
  const alias = config.aliases[aliasName]
  if (!alias)
    return undefined
  return alias.chain.flatMap((id) => {
    const resolved = resolveModel(config, id)
    return resolved ? [resolved] : []
  })
}

/** Directory for the configuration file and protected secrets. `COMPANION_CORE_HOME` overrides it. */
export function resolveHome(): string {
  return process.env.COMPANION_CORE_HOME ?? join(process.env.LOCALAPPDATA ?? homedir(), 'AIRI-Companion')
}

export function configPath(home = resolveHome()): string {
  return join(home, 'companion-core.json')
}

export async function loadConfig(path = configPath()): Promise<CompanionConfig> {
  return parseConfig(JSON.parse(await readFile(path, 'utf8')))
}

/** Writes a starter file that has no providers. Existing files are kept. Returns `true` when a file was created. */
export async function writeStarterConfig(path = configPath()): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true })
  const starter = { port: 11980, allowedOrigins: [], profile: 'cloud-mura-voice', providers: {}, models: {}, aliases: {} }
  try {
    await writeFile(path, `${JSON.stringify(starter, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    return true
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      return false
    throw error
  }
}
