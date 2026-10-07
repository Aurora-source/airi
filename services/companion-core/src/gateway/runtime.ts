import type { PromptDiagnostics } from '../budget/budgeter'
import type { CompanionConfig, ModelCapabilities, ResolvedModel } from '../config/config'

import { join } from 'node:path'

import { resolveHome } from '../config/config'
import { ProbeStore, withProbedCapabilities } from '../probe/store'
import { QuotaLedger } from '../quota/ledger'
import { ModelHealth } from '../routing/health'
import { Router } from '../routing/router'
import { StickyStore } from '../routing/sticky'
import { openDatabase } from '../store/database'

const RECENT_ROUTES = 50

/** One routed request, kept for the Ops view. It holds model ids, reasons, and token counts, and no message text. */
export interface RouteRecord {
  at: string
  alias: string
  pinned?: string
  /** The model that answered, when one did. */
  modelId?: string
  tier?: string
  /** One `model=outcome` entry per model that the gateway tried. */
  attempts: string[]
  /** One `model=reason` entry per model that the preflight skipped. */
  skipped: string[]
  prompt?: PromptDiagnostics
  status: number
  firstByteMs?: number
}

export interface GatewayRuntimeOptions {
  config: CompanionConfig
  /** Provider API keys by `keyRef`. */
  providerKeys: ReadonlyMap<string, string>
  /**
   * Overrides where the router reads capabilities from.
   *
   * @default the stored probe result of the model over its configured capabilities
   */
  capabilitiesOf?: (model: ResolvedModel) => ModelCapabilities
  now?: () => number
}

/**
 * The state that routing needs: the SQLite database, the quota ledger, the health tracker, the sticky store, and the router.
 * One gateway owns one runtime, and closing the gateway closes the database.
 */
export class GatewayRuntime {
  readonly config: CompanionConfig
  readonly providerKeys: ReadonlyMap<string, string>
  readonly ledger: QuotaLedger
  readonly health: ModelHealth
  readonly sticky: StickyStore
  readonly probes: ProbeStore
  readonly router: Router
  readonly now: () => number
  private readonly db: ReturnType<typeof openDatabase>
  private readonly routes: RouteRecord[] = []

  constructor(options: GatewayRuntimeOptions) {
    this.config = options.config
    this.providerKeys = options.providerKeys
    this.now = options.now ?? Date.now
    this.db = openDatabase(options.config.store.path ?? join(resolveHome(), 'companion-core.sqlite'))
    this.ledger = new QuotaLedger(this.db, this.now)
    this.health = new ModelHealth({ baseCooldownMs: options.config.routing.failureCooldownMs, maxCooldownMs: options.config.routing.failureCooldownMaxMs }, this.now)
    this.sticky = new StickyStore(this.db, this.now, {
      idleMs: options.config.routing.stickyIdleMinutes * 60_000,
      resetHour: options.config.routing.stickyResetHour,
    })
    this.probes = new ProbeStore(this.db, this.now)
    this.router = new Router({
      config: options.config,
      ledger: this.ledger,
      health: this.health,
      sticky: this.sticky,
      hasKey: model => !model.provider.keyRef || this.providerKeys.has(model.provider.keyRef),
      capabilitiesOf: options.capabilitiesOf ?? (model => withProbedCapabilities(model.capabilities, this.probes.get(model.id))),
      now: this.now,
    })
  }

  recordRoute(record: RouteRecord): void {
    this.routes.push(record)
    if (this.routes.length > RECENT_ROUTES)
      this.routes.shift()
  }

  recentRoutes(): readonly RouteRecord[] {
    return this.routes
  }

  close(): void {
    this.db.close()
  }
}
