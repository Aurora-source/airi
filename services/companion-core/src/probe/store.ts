import type { ModelCapabilities } from '../config/config'
import type { CompanionDatabase } from '../store/database'
import type { ProbeResult } from './probe'

const DEFAULT_MAX_AGE_MS = 7 * 24 * 3_600_000
/** The gateway reads the table at most this often, so that routing does not touch the database for every request. */
const READ_CACHE_MS = 30_000

export interface ProbeStoreOptions {
  /**
   * A result older than this is ignored, and the configuration applies again.
   *
   * @default 7 days
   */
  maxAgeMs?: number
}

/**
 * Keeps the last probe result of each model.
 *
 * The probe command writes it from its own process, and the gateway reads it. A result is cached in memory for 30 seconds,
 * so a new probe reaches a running gateway within that time and a request never waits for the database.
 */
export class ProbeStore {
  private readonly cache = new Map<string, { at: number, result: ProbeResult | undefined }>()
  private readonly maxAgeMs: number

  constructor(
    private readonly db: CompanionDatabase,
    private readonly now: () => number,
    options: ProbeStoreOptions = {},
  ) {
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  }

  set(result: ProbeResult): void {
    this.db.prepare('INSERT OR REPLACE INTO probe_result (model_id, probed_at_ms, result_json) VALUES (?, ?, ?)').run(result.modelId, result.probedAtMs, JSON.stringify(result))
    this.cache.delete(result.modelId)
  }

  /** The probe result of a model, or `undefined` when there is none or it is too old. */
  get(modelId: string): ProbeResult | undefined {
    const now = this.now()
    const cached = this.cache.get(modelId)
    if (cached && now - cached.at < READ_CACHE_MS)
      return this.fresh(cached.result, now)

    const row = this.db.prepare('SELECT result_json FROM probe_result WHERE model_id = ?').get(modelId) as { result_json: string } | undefined
    let result: ProbeResult | undefined
    if (row) {
      try {
        result = JSON.parse(row.result_json) as ProbeResult
      }
      catch {
        // A damaged row is the same as no probe. The configuration applies.
        result = undefined
      }
    }
    this.cache.set(modelId, { at: now, result })
    return this.fresh(result, now)
  }

  private fresh(result: ProbeResult | undefined, now: number): ProbeResult | undefined {
    return result && now - result.probedAtMs <= this.maxAgeMs ? result : undefined
  }
}

/**
 * The capabilities that the router uses for a model: what the probe measured, over what the configuration says.
 *
 * A result counts only when a plain request worked, because an unreachable provider or a rejected key says nothing about the
 * model. A deep probe can lower the prompt limit of the model. It never raises the limit that the configuration sets.
 */
export function withProbedCapabilities(configured: ModelCapabilities, probe: ProbeResult | undefined): ModelCapabilities {
  if (!probe?.working)
    return configured
  const accepted = probe.maxAcceptedPromptTokens
  return {
    ...configured,
    streaming: probe.streaming,
    tools: probe.tools,
    images: probe.images,
    structuredOutput: probe.structuredOutput,
    maxPrompt: accepted === undefined ? configured.maxPrompt : Math.min(accepted, configured.maxPrompt ?? Number.POSITIVE_INFINITY),
  }
}
