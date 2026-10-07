import type { AudioLimits, CompanionConfig } from '../config/config'

import { resolveAlias } from '../config/config'

/** One speech model of a `speech-recognition` chain. Configuration fixes the target, and client fields never change it. */
export interface TranscriptionModel {
  /** Key in `models`. */
  id: string
  /** `<provider baseURL>audio/transcriptions`. */
  url: URL
  /** Model name that the provider receives. */
  model: string
  keyRef?: string
  locality: 'cloud' | 'local'
}

export interface AudioRoutes {
  /** Chains by alias name, best first. */
  aliases: ReadonlyMap<string, readonly TranscriptionModel[]>
  limits: AudioLimits
}

/**
 * Reads speech recognition from the R2B configuration: each `speech-recognition` alias and its chain.
 * The compute profile already limits the chain, so a cloud profile holds no local speech model.
 * Returns `undefined` when no alias has the role, which disables transcription.
 *
 * Throws when a local speech provider does not use a literal loopback address.
 */
export function resolveAudioRoutes(config: CompanionConfig): AudioRoutes | undefined {
  const aliases = new Map<string, TranscriptionModel[]>()
  for (const [name, alias] of Object.entries(config.aliases)) {
    if (alias.role !== 'speech-recognition')
      continue
    aliases.set(name, (resolveAlias(config, name) ?? []).map((model) => {
      if (model.locality === 'local' && !isLoopbackTarget(model.provider.baseURL))
        throw new Error(`Speech model "${model.id}" is local, so its provider needs a literal loopback address.`)
      return {
        id: model.id,
        url: new URL('audio/transcriptions', model.provider.baseURL),
        model: model.model,
        keyRef: model.provider.keyRef,
        locality: model.locality,
      }
    }))
  }
  return aliases.size > 0 ? { aliases, limits: config.audio } : undefined
}

function isLoopbackTarget(value: string): boolean {
  const url = new URL(value)
  return ['http:', 'https:'].includes(url.protocol)
    && ['127.0.0.1', '[::1]'].includes(url.hostname)
    && !url.username && !url.password && !url.search && !url.hash
}
