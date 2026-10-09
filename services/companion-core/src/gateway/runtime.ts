import type { PromptDiagnostics } from '../budget/budgeter'
import type { CompanionConfig, ModelCapabilities, ResolvedModel } from '../config/config'
import type { CandidateThinking } from '../paid/paid-gemini'
import type { RouteAdmission } from '../routing/router'

import { dirname, join } from 'node:path'

import * as v from 'valibot'

import { resolveHome } from '../config/config'
import { OpsStateStore } from '../paid/ops-state'
import { PaidGemini } from '../paid/paid-gemini'
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
  /** The `reasoning_effort` that the Gateway sent, and who chose it. */
  effort?: CandidateThinking
}

const CLOUD_SUSPENSION_KEY = 'cloud-suspension'
const cloudSuspensionSchema = v.object({ suspended: v.boolean(), at: v.string() })

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
  /** Receives one line per background failure. Lines hold reasons, never text or keys. */
  report?: (message: string) => void
}

/**
 * The state that routing needs: the SQLite database, the quota ledger, the health tracker, the sticky store, and the router.
 * It also owns the Ops state file: settings that authenticated Ops requests make, and the paid request ledger.
 * One gateway owns one runtime, and closing the gateway closes both databases.
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
  readonly opsState: OpsStateStore
  readonly paid: PaidGemini
  private readonly db: ReturnType<typeof openDatabase>
  private readonly routes: RouteRecord[] = []

  constructor(options: GatewayRuntimeOptions) {
    this.config = options.config
    this.providerKeys = options.providerKeys
    this.now = options.now ?? Date.now
    const statePath = options.config.store.path ?? join(resolveHome(), 'companion-core.sqlite')
    this.db = openDatabase(statePath)
    this.opsState = new OpsStateStore(options.config.store.opsPath ?? (statePath === ':memory:' ? ':memory:' : join(dirname(statePath), 'companion-ops.sqlite')))
    this.paid = new PaidGemini({ config: options.config, store: this.opsState, hasKey: keyRef => this.providerKeys.has(keyRef), now: this.now, report: options.report })
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
      admission: this.admission(),
      now: this.now,
    })
  }

  /** Whether Ops suspended cloud inference. It survives restarts until Ops resumes it. */
  get cloudSuspended(): boolean {
    const stored = v.safeParse(cloudSuspensionSchema, this.opsState.setting(CLOUD_SUSPENSION_KEY))
    return stored.success && stored.output.suspended
  }

  /** Records an authenticated Ops decision. A suspension skips every cloud model, chat and vision alike. */
  setCloudSuspended(suspended: boolean): void {
    this.opsState.setSetting(CLOUD_SUSPENSION_KEY, { suspended, at: new Date(this.now()).toISOString() }, this.now())
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
    this.opsState.close()
  }

  private admission(): RouteAdmission {
    return {
      chain: (alias, chain) => this.paid.chain(alias, chain),
      leader: alias => this.paid.leader(alias)?.id,
      admit: (model, body, isLeader) => {
        if (model.locality === 'cloud' && this.cloudSuspended)
          return { skip: { reason: 'CLOUD_SUSPENDED', detail: 'cloud inference is suspended in Ops' } }
        return this.paid.admit(model, body, isLeader)
      },
    }
  }
}
