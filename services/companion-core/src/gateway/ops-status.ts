import type { GatewayRuntime } from './runtime'

import { resolveAlias } from '../config/config'

/**
 * The routing state for the Ops view: for each alias, each model with its limits, usage, cool-down, health, and the
 * choices that conversations hold, and the last routed requests.
 *
 * It holds model ids, reasons, and counts only. It has no keys, tokens, or message text.
 * The configured limits and what the provider reported stay apart, so that a reader sees which number is which.
 */
export function opsStatus(runtime: GatewayRuntime) {
  const { config } = runtime
  const aliases = Object.fromEntries(Object.entries(config.aliases).map(([name, alias]) => [name, {
    role: alias.role,
    chain: (resolveAlias(config, name) ?? []).map(model => ({
      id: model.id,
      provider: model.providerName,
      model: model.model,
      locality: model.locality,
      quality: model.quality,
      capabilities: model.capabilities,
      health: runtime.health.snapshot(model.id),
      ledger: runtime.ledger.snapshot(model.scope, model.limits),
    })),
  }]))
  return {
    profile: config.profile,
    cloudSuspended: runtime.cloudSuspended,
    aliases,
    sticky: runtime.sticky.list(),
    recentRoutes: runtime.recentRoutes(),
  }
}
