import type { InferOutput } from 'valibot'

import process from 'node:process'

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { errorMessageFrom } from '@moeru/std'

import * as v from 'valibot'

import { serverBase } from '../companion/sources/network'

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

const appList = v.optional(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(128))), [])

const perceptionSchema = v.object({
  /** Creates the screen capture backend and the perception service. `look_now` works only when this is on. */
  enabled: v.optional(v.boolean(), false),
  /** Periodic capture and automatic cloud vision. It needs `enabled`. Off by default. */
  ambient: v.optional(v.boolean(), false),
  /** A `vision` alias. Its chain, profile rules, quota, and health decide which model observes the screen. */
  visionAlias: v.optional(v.string(), 'companion-vision'),
  /** Hybrid profile only: local models of the vision chain can answer after every cloud model failed. */
  allowLocalFallback: v.optional(v.boolean(), false),
  captureIntervalMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(500)), 2000),
  /** How long an observation counts as current, from the moment of capture. */
  ttlMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1000), v.maxValue(120_000)), 15_000),
  /** Shortest time between two automatic vision requests. */
  minimumIntervalMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1000)), 20_000),
  /** Absent means a static screen is never sent again. */
  maximumIdleRefreshMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(10_000))),
  attemptTimeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1000)), 11_000),
  visionTimeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1000)), 12_000),
  /** Width of the encoded frame. Downscaling happens on this machine before any upload. */
  maxWidth: v.optional(v.pipe(v.number(), v.integer(), v.minValue(320), v.maxValue(1920)), 1280),
  jpegQuality: v.optional(v.pipe(v.number(), v.integer(), v.minValue(30), v.maxValue(95)), 70),
  privacy: v.optional(v.object({
    /** Process names that block capture and upload, for example `keepass`. */
    excludedApps: appList,
    /** Window title parts that block capture and upload. */
    excludedWindows: appList,
    /** Process names that are captured for change detection but never uploaded. */
    limitedApps: appList,
    /** Process names that count as known and safe, next to the built-in list. Unknown apps block automatic upload. */
    classifiedApps: appList,
    /** Process names that always count as sensitive, next to the built-in list. */
    sensitiveApps: appList,
  }), {}),
})

const watchSchema = v.object({
  /**
   * Follows the video that the AIRI browser extension reports on the server channel: identity, playback, and captions.
   * It adds the WATCH block to chat requests and the `watch_status` tool. It uses `channel.url`.
   */
  enabled: v.optional(v.boolean(), true),
  /** Sends watch start, stop, a confirmed episode end, and shared moments to memory. Memory decides what it keeps. */
  memoryEvents: v.optional(v.boolean(), true),
  /** Shortest time between two admitted reactions. */
  reactionCooldownMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(10_000)), 180_000),
  systemAudio: v.optional(v.object({
    /**
     * Transcribes one short system-output segment on an explicit request, only while captions are missing.
     * AIRI desktop captures the segment. The microphone is never used.
     */
    enabled: v.optional(v.boolean(), false),
    /** A `speech-recognition` alias. The R3 transcription route uses its chain. */
    alias: v.optional(v.string(), 'companion-stt'),
    /** Recognition language when no caption language is known. */
    language: v.optional(v.picklist(['en', 'ja']), 'en'),
  }), {}),
  anilist: v.optional(v.object({
    /** Looks up identity, title variants, episode count, and duration for an AniList id that the user confirmed. */
    enabled: v.optional(v.boolean(), false),
  }), {}),
  /** Desktop players and media servers next to the browser extension. Each source is off until the user enables it. */
  sources: v.optional(v.object({
    jellyfin: v.optional(v.object({
      enabled: v.optional(v.boolean(), false),
      /**
       * The server that the user chose, for example `https://media.example.com` or `http://192.168.1.20:8096`.
       * Plain http needs a host whose every address is private. The Core never searches the network for servers.
       */
      url: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(512))),
      /** Name of the protected secret that holds the access token. `companion-core jellyfin-connect` stores it. */
      tokenRef: v.optional(v.pipe(v.string(), v.regex(/^[a-z0-9-]+$/)), 'jellyfin-token'),
      /** Follows Jellyfin Media Player sessions whose device name is this computer's name. */
      followThisComputer: v.optional(v.boolean(), true),
      /** Device ids or names to follow besides this computer, for example a TV. Other devices need an Ops selection. */
      devices: v.optional(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(128))), []),
      /** Looks up the current cue of a text subtitle stream when the player reports no subtitle text. */
      serverSubtitles: v.optional(v.boolean(), true),
    }), {}),
    mpv: v.optional(v.object({
      enabled: v.optional(v.boolean(), false),
      /** Pipes of `input-ipc-server=\\.\pipe\<name>`. `jellyfin-media-player` marks the pipe of Jellyfin Media Player. */
      pipes: v.optional(v.array(v.object({
        name: v.pipe(v.string(), v.regex(/^[\w.-]{1,64}$/)),
        player: v.optional(v.picklist(['mpv', 'jellyfin-media-player']), 'mpv'),
      })), [{ name: 'airi-mpv', player: 'mpv' }]),
    }), {}),
    vlc: v.optional(v.object({
      enabled: v.optional(v.boolean(), false),
      /** Port of VLC's HTTP interface on 127.0.0.1. */
      port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535)), 8080),
      /** Name of the protected secret that holds the HTTP interface password. */
      passwordRef: v.optional(v.pipe(v.string(), v.regex(/^[a-z0-9-]+$/)), 'vlc-http-password'),
    }), {}),
  }), {}),
})

const minuteOfDay = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1439))

/**
 * The Director chooses when the companion reacts, waits, or stays silent. It uses the server channel.
 * Proactive speech and optional reasoning are not configuration: only an authenticated Ops request enables them.
 */
const directorSchema = v.object({
  enabled: v.optional(v.boolean(), true),
  /** Silent visual reactions. `low` allows one per 30 seconds, `normal` one per 15 seconds. R6 cooldown still applies. */
  reactionFrequency: v.optional(v.picklist(['off', 'low', 'normal']), 'low'),
  /** Suppresses speech and visual reactions. Answers to the user stay unchanged. */
  quietMode: v.optional(v.boolean(), false),
  /** Local offset for quiet periods. @default the offset of this computer when the Director starts */
  utcOffsetMinutes: v.optional(v.pipe(v.number(), v.integer(), v.minValue(-840), v.maxValue(840))),
  /** Daily quiet intervals in local minutes. An interval can cross midnight. Equal ends mean the whole day. */
  quietPeriods: v.optional(v.pipe(v.array(v.strictObject({ startMinute: minuteOfDay, endMinute: minuteOfDay })), v.maxLength(8)), []),
  /** A `reasoning` alias for optional Director reasoning. Without it, reasoning stays unavailable. */
  reasoningAlias: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(64))),
})

/**
 * The paid Gemini model selection that Ops controls, and the usage ledger. Without a Gemini provider it stays unavailable.
 * The model and effort are not configuration: only an authenticated Ops request changes them.
 */
const paidGeminiSchema = v.object({
  /** The chat alias that the selected model leads. @default `companion-chat` when that alias serves chat completions */
  alias: v.optional(v.pipe(v.string(), v.minLength(1))),
  /** Provider of the selected model. It needs `compat: gemini`. @default the only cloud provider with `compat: gemini` */
  provider: v.optional(v.pipe(v.string(), v.minLength(1))),
  /** Time zone of the daily and monthly usage windows. Google Cloud billing reports use Pacific time. */
  timeZone: v.optional(v.pipe(v.string(), v.minLength(1)), 'America/Los_Angeles'),
  /** Days of paid request records to keep. */
  retentionDays: v.optional(v.pipe(v.number(), v.integer(), v.minValue(7), v.maxValue(1000)), 400),
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
    /**
     * `path`: SQLite file for the quota ledger, sticky choices, and probe results.
     * `opsPath`: SQLite file for Ops settings and the paid request ledger. @default `companion-ops.sqlite` next to `path`
     * `:memory:` keeps a file in memory.
     */
    store: v.optional(v.object({ path: v.optional(v.string()), opsPath: v.optional(v.string()) }), {}),
    memory: v.optional(memorySchema, {}),
    channel: v.optional(channelSchema, {}),
    perception: v.optional(perceptionSchema, {}),
    watch: v.optional(watchSchema, {}),
    director: v.optional(directorSchema, {}),
    paidGemini: v.optional(paidGeminiSchema, {}),
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
    if (config.perception.enabled && config.aliases[config.perception.visionAlias]?.role !== 'vision')
      addIssue({ message: `Perception needs alias "${config.perception.visionAlias}" with role "vision".` })
    if (config.perception.ambient && !config.perception.enabled)
      addIssue({ message: 'perception.ambient needs perception.enabled.' })
    if (config.watch.systemAudio.enabled && config.aliases[config.watch.systemAudio.alias]?.role !== 'speech-recognition')
      addIssue({ message: `watch.systemAudio needs alias "${config.watch.systemAudio.alias}" with role "speech-recognition".` })
    if (!isTimeZone(config.paidGemini.timeZone))
      addIssue({ message: `paidGemini.timeZone "${config.paidGemini.timeZone}" is not a known time zone.` })
    const paidAlias = config.paidGemini.alias
    if (paidAlias !== undefined && (!config.aliases[paidAlias] || !servesChatCompletions(config.aliases[paidAlias])))
      addIssue({ message: `paidGemini.alias "${paidAlias}" must name an alias that serves chat completions.` })
    const paidProvider = config.paidGemini.provider
    if (paidProvider !== undefined && (config.providers[paidProvider]?.compat !== 'gemini' || config.providers[paidProvider]?.locality !== 'cloud'))
      addIssue({ message: `paidGemini.provider "${paidProvider}" must name a cloud provider with compat "gemini".` })
    const jellyfin = config.watch.sources.jellyfin
    if (jellyfin.enabled) {
      try {
        serverBase(jellyfin.url ?? '')
      }
      catch (error) {
        addIssue({ message: `watch.sources.jellyfin.url: ${errorMessageFrom(error) ?? 'invalid'}` })
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
export type PerceptionConfig = CompanionConfig['perception']
export type WatchConfig = CompanionConfig['watch']
export type MediaSourcesConfig = CompanionConfig['watch']['sources']
export type PaidGeminiConfig = CompanionConfig['paidGemini']

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

function isTimeZone(value: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  }
  catch {
    return false
  }
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
