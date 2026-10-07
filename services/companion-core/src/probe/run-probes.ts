import type { CompanionConfig } from '../config/config'
import type { ProbeResult } from './probe'
import type { ProbeStore } from './store'

import { resolveModel } from '../config/config'
import { probeModel } from './probe'

export interface RunProbesOptions {
  /** Models to probe, by id. Without it, every model of every alias chain. */
  modelIds?: string[]
  /** Pause between models, so that a burst of probes does not spend a provider's per-minute limit. */
  gapMs?: number
  /** Ask each model for the largest prompt that it accepts. This costs quota. */
  deepStepsTokens?: number[]
  timeoutMs?: number
  onResult?: (result: ProbeResult) => void
}

/**
 * Probes models one after the other and stores each result.
 *
 * It follows the compute profile: a cloud profile never calls a local model, because a request to a local server
 * loads that model into memory. Companion Ops starts local inference, and the gateway never does.
 * A model without its key gets a failed result and no request.
 *
 * Call stack:
 *
 * runProbes
 *   -> {@link probeModel} (./probe)
 *   -> ProbeStore.set (./store)
 */
export async function runProbes(config: CompanionConfig, providerKeys: ReadonlyMap<string, string>, store: ProbeStore, options: RunProbesOptions = {}): Promise<ProbeResult[]> {
  const chainIds = [...new Set(Object.values(config.aliases).flatMap(alias => alias.chain))]
  const wanted = options.modelIds ?? chainIds
  const results: ProbeResult[] = []

  for (const [index, modelId] of wanted.entries()) {
    const model = resolveModel(config, modelId)
    if (!model)
      continue
    const forbidsLocal = (config.profile === 'cloud' || config.profile === 'cloud-mura-voice') && model.locality === 'local'
    const forbidsCloud = config.profile === 'local' && model.locality === 'cloud'
    if (forbidsLocal || forbidsCloud)
      continue

    if (index > 0 && options.gapMs)
      await new Promise(resolve => setTimeout(resolve, options.gapMs))

    const apiKey = model.provider.keyRef ? providerKeys.get(model.provider.keyRef) : undefined
    let result: ProbeResult
    if (model.provider.keyRef && !apiKey) {
      result = {
        modelId,
        probedAtMs: Date.now(),
        reachable: false,
        working: false,
        streaming: false,
        tools: false,
        toolCallIndexMissing: false,
        images: false,
        structuredOutput: false,
        failures: { key: `no key is stored for "${model.provider.keyRef}"` },
      }
    }
    else {
      const deep = options.deepStepsTokens?.filter(tokens => tokens <= model.capabilities.contextWindow)
      result = await probeModel(model, { apiKey, timeoutMs: options.timeoutMs, deep: deep?.length ? { stepsTokens: deep } : undefined })
    }
    store.set(result)
    options.onResult?.(result)
    results.push(result)
  }
  return results
}
