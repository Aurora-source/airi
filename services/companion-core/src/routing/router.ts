import type { InjectedUnit } from '../budget/budgeter'
import type { WireRequest } from '../budget/wire'
import type { CompanionConfig, ModelCapabilities, ResolvedModel } from '../config/config'
import type { CandidateThinking } from '../paid/paid-gemini'
import type { QuotaLedger } from '../quota/ledger'
import type { Candidate, Skip, SkipReason } from './eligibility'
import type { ModelHealth } from './health'
import type { RequestTraits } from './request-analysis'
import type { StickyStore } from './sticky'

import { resolveAlias, servesChatCompletions } from '../config/config'
import { evaluateModel } from './eligibility'
import { analyzeRequest } from './request-analysis'

export interface RouterDeps {
  config: CompanionConfig
  ledger: QuotaLedger
  health: ModelHealth
  sticky: StickyStore
  /** Whether the gateway holds the key of the model's provider. */
  hasKey: (model: ResolvedModel) => boolean
  /** Capabilities that a live probe measured for a model. They replace the configured ones. */
  capabilitiesOf?: (model: ResolvedModel) => ModelCapabilities
  /** Ops controls: the selected model, thinking efforts, spending limits, and cloud suspension. */
  admission?: RouteAdmission
  now: () => number
}

/** What Ops decided for routing. Absent means the configured chains as they are. */
export interface RouteAdmission {
  /** The chain to try for an unpinned request of an alias. */
  chain: (alias: string, chain: ResolvedModel[]) => ResolvedModel[]
  /** The model that the user selected for an alias. It goes first, like a sticky choice. */
  leader: (alias: string) => string | undefined
  /** Checks before eligibility. A skip names its reason. A candidate can get a thinking effort. */
  admit: (model: ResolvedModel, body: WireRequest, isLeader: boolean) => { skip: { reason: SkipReason, detail?: string } } | { thinking?: CandidateThinking }
}

export interface RouteError {
  status: 400 | 404 | 413 | 429 | 503
  code: string
  message: string
  /** For a 429: the time until the earliest model is free again. */
  retryAfterMs?: number
  skipped: Skip[]
}

export type RoutePlan
  = | {
    ok: true
    alias: string
    /** Model id from `alias:model`. Only that model can serve the request, and nothing falls back from it. */
    pinned?: string
    conversationKey: string
    stickyModelId?: string
    traits: RequestTraits
    /** Models that can take the request, in the order to try them. */
    candidates: Candidate[]
    skipped: Skip[]
  }
  | { ok: false, error: RouteError }

/**
 * Chooses which models can serve a request and in what order. It sends nothing and changes nothing.
 *
 * Order of candidates:
 * 1. Healthy models come before models that failed recently. A resting model is a last resort and not a refusal.
 * 2. Models that carry the whole logical turn come before models that carry only its first round.
 * 3. Inside each group, the model that already serves this conversation comes first.
 *    A different model can change the character, so the conversation moves only when its model cannot take the request.
 * 4. The rest follow the chain order of the alias.
 *
 * A model name `alias:model` is an explicit override. Only that model serves it.
 * An Ops model selection leads its alias. The configured chain after it stays the authorized fallback.
 */
export class Router {
  constructor(private readonly deps: RouterDeps) {}

  /**
   * `injected` holds the gateway's memory and awareness blocks. Each candidate budgets them with its own limits.
   * `allowLocal: false` skips local models of the chain. Perception uses it unless local fallback was allowed explicitly.
   */
  plan(body: WireRequest, injected?: readonly InjectedUnit[], options: { allowLocal?: boolean } = {}): RoutePlan {
    const target = this.resolveTarget(body.model)
    if (!target)
      return failure(404, 'model_not_found', `Model "${body.model}" is not a configured alias or a model of one.`, [])

    const { alias, pinned } = target
    const aliasConfig = this.deps.config.aliases[alias]
    if (!servesChatCompletions(aliasConfig))
      return failure(400, 'model_not_supported', `Model "${body.model}" is a ${aliasConfig.role} alias. It does not serve chat completions.`, [])
    const chain = resolveAlias(this.deps.config, alias)!
    const { admission } = this.deps
    const leaderId = pinned ? undefined : admission?.leader(alias)
    const models = pinned ? chain.filter(model => model.id === pinned) : admission?.chain(alias, chain) ?? chain
    const traits = analyzeRequest(body)
    const context = {
      profile: this.deps.config.profile,
      routing: this.deps.config.routing,
      alias: aliasConfig,
      ledger: this.deps.ledger,
      health: this.deps.health,
      hasKey: this.deps.hasKey,
      capabilitiesOf: this.deps.capabilitiesOf,
      injected,
    }

    const candidates: Candidate[] = []
    const skipped: Skip[] = []
    for (const model of models) {
      if (options.allowLocal === false && model.locality === 'local') {
        skipped.push({ modelId: model.id, reason: 'PROFILE_FORBIDS_LOCAL', category: 'ineligible' })
        continue
      }
      const admitted = admission?.admit(model, body, model.id === leaderId)
      if (admitted && 'skip' in admitted) {
        skipped.push({ modelId: model.id, reason: admitted.skip.reason, category: 'ineligible', detail: admitted.skip.detail })
        continue
      }
      const result = evaluateModel(model, body, traits, context)
      if ('candidate' in result)
        candidates.push(admitted?.thinking ? { ...result.candidate, thinking: admitted.thinking } : result.candidate)
      else
        skipped.push(result.skip)
    }

    // The user's selection outranks the conversation's earlier model.
    const stickyModelId = pinned ? undefined : leaderId ?? this.deps.sticky.get(alias, traits.conversationKey)?.modelId
    if (candidates.length === 0)
      return { ok: false, error: this.errorFor(skipped, pinned) }

    return {
      ok: true,
      alias,
      pinned,
      conversationKey: traits.conversationKey,
      stickyModelId,
      traits,
      candidates: orderCandidates(candidates, stickyModelId),
      skipped,
    }
  }

  /** Splits `alias` or `alias:model` into the alias and an optional pinned model of its chain. */
  private resolveTarget(name: string): { alias: string, pinned?: string } | undefined {
    const { aliases } = this.deps.config
    if (name in aliases)
      return { alias: name }
    const alias = Object.keys(aliases).find(candidate => name.startsWith(`${candidate}:`))
    if (!alias)
      return undefined
    const pinned = name.slice(alias.length + 1)
    return aliases[alias].chain.includes(pinned) ? { alias, pinned } : undefined
  }

  private errorFor(skipped: Skip[], pinned: string | undefined): RouteError {
    const summary = skipped.map(skip => `${skip.modelId}: ${skip.reason}${skip.detail ? ` (${skip.detail})` : ''}`).join('; ')
    // "No model of this alias can ..." and "The pinned model "x" cannot ..." read as the same fact for the two cases.
    const subject = pinned ? `The pinned model "${pinned}"` : 'No model of this alias'
    const can = pinned ? 'cannot' : 'can'
    const unavailable = skipped.filter(skip => skip.category === 'unavailable')
    if (unavailable.length > 0) {
      const earliest = Math.min(...unavailable.map(skip => skip.retryAtMs ?? Number.POSITIVE_INFINITY))
      const retryAfterMs = Number.isFinite(earliest) ? Math.max(0, earliest - this.deps.now()) : undefined
      return { status: 429, code: 'rate_limit_exceeded', message: `${subject} ${can} take this request right now. ${summary}`, retryAfterMs, skipped }
    }
    if (skipped.some(skip => skip.reason === 'CONTEXT_TOO_SMALL' || skip.reason === 'TPM_INELIGIBLE'))
      return { status: 413, code: 'request_too_large', message: `${subject} ${can} take a request of this size. ${summary}`, skipped }
    if (skipped.some(skip => skip.reason === 'CLOUD_SUSPENDED') && skipped.every(skip => skip.reason === 'CLOUD_SUSPENDED' || skip.reason === 'PROFILE_FORBIDS_LOCAL'))
      return { status: 503, code: 'cloud_suspended', message: `Cloud inference is suspended in Ops. ${summary}`, skipped }
    if (skipped.every(skip => skip.reason === 'SPENDING_LIMIT' || skip.category === 'ineligible') && skipped.some(skip => skip.reason === 'SPENDING_LIMIT'))
      return { status: 429, code: 'spending_limit_reached', message: `A spending limit set in Ops is reached. ${summary}`, skipped }
    if (skipped.some(skip => skip.reason.startsWith('CAPABILITY_') || skip.reason.startsWith('THINKING_')))
      return { status: 400, code: 'unsupported_request', message: `${subject} ${pinned ? 'does not support' : 'supports'} what this request needs. ${summary}`, skipped }
    return { status: 503, code: 'no_provider_available', message: `${subject} ${pinned ? 'is not' : 'is'} available. ${summary}`, skipped }
  }
}

function failure(status: RouteError['status'], code: string, message: string, skipped: Skip[]): RoutePlan {
  return { ok: false, error: { status, code, message, skipped } }
}

function orderCandidates(candidates: Candidate[], stickyModelId: string | undefined): Candidate[] {
  const order = (tier: Candidate['tier'], resting: boolean) => {
    const group = candidates.filter(candidate => candidate.tier === tier && (candidate.restingUntilMs !== undefined) === resting)
    const sticky = group.filter(candidate => candidate.model.id === stickyModelId)
    return [...sticky, ...group.filter(candidate => candidate.model.id !== stickyModelId)]
  }
  return [order('full', false), order('first-round-only', false), order('full', true), order('first-round-only', true)].flat()
}
