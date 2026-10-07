import type { BudgetResult, PromptDiagnostics } from '../budget/budgeter'
import type { WireRequest } from '../budget/wire'
import type { AliasConfig, ModelCapabilities, Profile, ResolvedModel, RoutingOptions } from '../config/config'
import type { QuotaLedger, QuotaNeed, QuotaReason } from '../quota/ledger'
import type { ModelHealth } from './health'
import type { RequestTraits } from './request-analysis'

import { budgetRequest, promptTokensOf } from '../budget/budgeter'
import { createTokenEstimator } from '../budget/estimate'
import { withStyleReminder } from '../providers/style-reminder'

/** Output of the first round of a tool turn: a short tool call. */
const TOOL_CALL_OUTPUT_TOKENS = 150
/** What the model's own tool-call message adds to the second request of a tool turn. */
const TOOL_CALL_MESSAGE_TOKENS = 120
const MIN_CONTEXT_MARGIN_TOKENS = 256
const CONTEXT_MARGIN_SHARE = 0.02

/**
 * Why a model cannot take a request.
 *
 * `ineligible` means that waiting does not help: the request does not fit the model, or the model cannot do what the request needs.
 * `unavailable` means that the model could take the request later: it is resting, or a quota window is full.
 * A request that is too big for a provider is therefore ineligible and never unhealthy.
 */
export type SkipReason
  = | 'PROFILE_FORBIDS_LOCAL'
    | 'PROFILE_FORBIDS_CLOUD'
    | 'KEY_MISSING'
    | 'CAPABILITY_STREAMING'
    | 'CAPABILITY_TOOLS'
    | 'CAPABILITY_IMAGES'
    | 'CAPABILITY_STRUCTURED_OUTPUT'
    | 'CONTEXT_TOO_SMALL'
    | 'TPM_INELIGIBLE'
    | QuotaReason

const UNAVAILABLE_REASONS = new Set<SkipReason>(['COOLING_DOWN', 'OBSERVED_REQUESTS_EXHAUSTED', 'RPM_EXHAUSTED', 'RPD_EXHAUSTED', 'TPM_WINDOW_FULL', 'TPD_EXHAUSTED'])

export interface Skip {
  modelId: string
  reason: SkipReason
  category: 'ineligible' | 'unavailable'
  /** For an unavailable model: the time of the next chance. */
  retryAtMs?: number
  detail?: string
}

/**
 * - `full`: the model can carry every round that the turn can need.
 * - `first-round-only`: the model fits the first request of a tool turn, and not the second.
 *   It serves a turn that probably needs no tool, and only after every `full` model is out.
 */
export type Tier = 'full' | 'first-round-only'

export interface Candidate {
  model: ResolvedModel
  tier: Tier
  /** The request to send, trimmed to the model. Its `model` field still holds the alias. */
  body: WireRequest
  budget: Exclude<BudgetResult, { status: 'impossible' }>
  diagnostics: PromptDiagnostics
  /** Tokens of the request, as estimated with this model's calibration. The ledger counts this when the request starts. */
  estimatedInputTokens: number
  /** What the logical turn is expected to spend. The ledger checked it. */
  need: QuotaNeed
  targetTokens: number
  /** Hard prompt limit of this model for this turn: context, `maxPrompt`, quality policy, and rate limit together. */
  maxPromptTokens: number
  /**
   * Set when the model failed recently. A resting model still takes requests, because the failure can be a one-off
   * and a refusal costs more than a try. The router puts it behind every healthy model.
   */
  restingUntilMs?: number
}

export interface EligibilityContext {
  profile: Profile
  routing: RoutingOptions
  alias: AliasConfig
  ledger: QuotaLedger
  health: ModelHealth
  /** Whether the gateway holds the key of the model's provider. A keyless local provider always has one. */
  hasKey: (model: ResolvedModel) => boolean
  /** Capabilities that a live probe measured. They replace the configured ones. */
  capabilitiesOf?: (model: ResolvedModel) => ModelCapabilities
}

type TierPlan
  = | { feasible: true, tier: Tier, candidate: Omit<Candidate, 'need'> & { rounds: number }, requests: number }
    | { feasible: false, reason: SkipReason, detail: string }

/**
 * The prompt size that the quality policy wants for this request.
 * `auto` takes the expanded target when tools were busy in the recent turns, because that history still matters.
 */
export function policyTargetOf(prompt: AliasConfig['prompt'], traits: RequestTraits): number {
  switch (prompt.mode) {
    case 'soft': return prompt.softTarget
    case 'expanded': return prompt.expandedTarget
    case 'max': return prompt.maxTarget
    default: return traits.recentToolExchanges >= 2 ? prompt.expandedTarget : prompt.softTarget
  }
}

/**
 * Decides, before anything is sent, whether a model can take a request, and in what form.
 *
 * It looks at the whole logical turn. A request that offers tools can become a second request that carries the tool result,
 * so a model with a small per-minute token limit can fit the first request and still fail the second with a 429.
 * The checks run in this order, and the first that fails names the reason:
 * 1. Profile, key, and capabilities.
 * 2. Capacity: the budgeter trims the history to the smallest of the quality target, the context window, `maxPrompt`,
 *    and what the per-minute limit leaves for the turn. A request whose fixed part exceeds that is ineligible.
 * 3. The quota ledger. A quota block skips the model, because a request into a known 429 only wastes quota.
 *    Health does not skip. A model that failed recently is marked as resting.
 *
 * Call stack:
 *
 * {@link evaluateModel}
 *   -> planTier
 *     -> {@link budgetRequest} (../budget/budgeter)
 *   -> QuotaLedger.check (../quota/ledger)
 */
export function evaluateModel(model: ResolvedModel, body: WireRequest, traits: RequestTraits, context: EligibilityContext): { candidate: Candidate } | { skip: Skip } {
  const skip = (reason: SkipReason, extra: Partial<Skip> = {}): { skip: Skip } => ({
    skip: { modelId: model.id, reason, category: UNAVAILABLE_REASONS.has(reason) ? 'unavailable' : 'ineligible', ...extra },
  })

  if (context.profile === 'local' && model.locality === 'cloud')
    return skip('PROFILE_FORBIDS_CLOUD')
  if ((context.profile === 'cloud' || context.profile === 'cloud-mura-voice') && model.locality === 'local')
    return skip('PROFILE_FORBIDS_LOCAL')
  if (!context.hasKey(model))
    return skip('KEY_MISSING')

  const capabilities = context.capabilitiesOf?.(model) ?? model.capabilities
  if (traits.stream && !capabilities.streaming)
    return skip('CAPABILITY_STREAMING')
  if (traits.hasTools && !capabilities.tools)
    return skip('CAPABILITY_TOOLS')
  if (traits.hasImages && !capabilities.images)
    return skip('CAPABILITY_IMAGES')
  if (traits.structuredOutput && !capabilities.structuredOutput)
    return skip('CAPABILITY_STRUCTURED_OUTPUT')

  // A tool-offering first request can need a second one. The second round alone (a continuation) is one request.
  const rounds: { tier: Tier, rounds: number }[] = []
  if (traits.hasTools && !traits.toolContinuation) {
    rounds.push({ tier: 'full', rounds: 2 })
    if (!traits.toolsRequired && context.routing.allowFirstRoundOnly)
      rounds.push({ tier: 'first-round-only', rounds: 1 })
  }
  else {
    rounds.push({ tier: 'full', rounds: 1 })
  }

  // The reminder is part of what the model receives, so it is counted and budgeted with the rest of the system prompt.
  const prepared = withStyleReminder(body, model.styleReminder)
  const plans = rounds.map(({ tier, rounds: count }) => planTier(model, capabilities, prepared, traits, context, tier, count))
  const feasible = plans.filter((plan): plan is Extract<TierPlan, { feasible: true }> => plan.feasible)
  if (feasible.length === 0) {
    const first = plans[0] as Extract<TierPlan, { feasible: false }>
    return skip(first.reason, { detail: first.detail })
  }

  const restingUntilMs = context.health.coolingUntil(model.id)

  let firstBlock: { reason: QuotaReason, retryAtMs: number, detail?: string } | undefined
  for (const plan of feasible) {
    const need = needOf(plan.candidate.estimatedInputTokens, plan.candidate.rounds, plan.requests, capabilities, body, context)
    const verdict = context.ledger.check(model.scope, model.limits, need)
    if (verdict.ok) {
      const { rounds: _rounds, ...candidate } = plan.candidate
      return { candidate: { ...candidate, need, restingUntilMs } }
    }
    firstBlock ??= verdict
  }
  return skip(firstBlock!.reason, { retryAtMs: firstBlock!.retryAtMs, detail: firstBlock!.detail })
}

function planTier(model: ResolvedModel, capabilities: ModelCapabilities, body: WireRequest, traits: RequestTraits, context: EligibilityContext, tier: Tier, rounds: number): TierPlan {
  const estimator = createTokenEstimator({ calibration: context.health.calibration(model.id), imageTokens: capabilities.imageTokens })
  const outputReserve = outputReserveOf(body, capabilities, context)
  const margin = Math.max(MIN_CONTEXT_MARGIN_TOKENS, Math.ceil(capabilities.contextWindow * CONTEXT_MARGIN_SHARE))
  const contextLimit = capabilities.contextWindow - outputReserve - margin
  // Hard limits that come from the model and the quality policy.
  const configuredMax = Math.floor(Math.min(contextLimit, capabilities.maxPrompt ?? Number.POSITIVE_INFINITY, context.alias.prompt.maxTarget))
  const secondRoundExtra = TOOL_CALL_MESSAGE_TOKENS + context.routing.toolResultReserveTokens
  const rateCap = Math.floor(ratePromptCap(model, rounds, secondRoundExtra, outputReserve, context.routing.tokenSafetyMargin))
  const cap = Math.min(configuredMax, rateCap)

  // Target 0 reports the fixed part of the request: system messages, tool schemas, and the current turn.
  const fixed = budgetRequest(body, { estimator, targetTokens: 0, outputReserveTokens: outputReserve })
  const required = fixed.status === 'impossible' ? fixed.requiredTokens : promptTokensOf(fixed.diagnostics)
  if (required > cap) {
    const rateLimited = required <= configuredMax
    return {
      feasible: false,
      reason: rateLimited ? 'TPM_INELIGIBLE' : 'CONTEXT_TOO_SMALL',
      detail: rateLimited
        ? `the fixed part of the request is ${required} tokens, and the ${rounds === 2 ? 'whole tool turn' : 'request'} must fit the limit of ${model.limits.tpm} tokens per minute`
        : `the fixed part of the request is ${required} tokens, and the model takes at most ${configuredMax}`,
    }
  }

  // The quality target is a target. A fixed part above it is still sent, as long as the model takes it.
  const target = Math.max(Math.min(policyTargetOf(context.alias.prompt, traits), cap), required)
  const result = fixed.status === 'untrimmed'
    ? fixed
    : budgetRequest(body, { estimator, targetTokens: target, outputReserveTokens: outputReserve, lowWaterRatio: context.alias.prompt.lowWaterRatio })
  if (result.status === 'impossible')
    return { feasible: false, reason: 'CONTEXT_TOO_SMALL', detail: `the fixed part of the request is ${result.requiredTokens} tokens` }

  return {
    feasible: true,
    tier,
    requests: rounds,
    candidate: {
      model,
      tier,
      rounds,
      body: result.body,
      budget: result,
      diagnostics: result.diagnostics,
      estimatedInputTokens: promptTokensOf(result.diagnostics),
      targetTokens: target,
      maxPromptTokens: cap,
    },
  }
}

/**
 * What the model's per-minute limit leaves for the prompt of one request.
 *
 * Two rounds cost `X + (X + extra)` input tokens, where X is the prompt and `extra` is the tool call plus the tool result.
 * A provider that meters total tokens also counts the outputs. The safety margin covers estimation error.
 */
function ratePromptCap(model: ResolvedModel, rounds: number, secondRoundExtra: number, outputReserve: number, safety: number): number {
  const tpm = model.limits.tpm
  if (tpm === undefined)
    return Number.POSITIVE_INFINITY
  const budget = tpm / safety
  const metersOutput = model.limits.tpmBasis === 'total'
  if (rounds === 1)
    return budget - (metersOutput ? outputReserve : 0)
  const outputs = metersOutput ? Math.min(outputReserve, TOOL_CALL_OUTPUT_TOKENS) + outputReserve : 0
  return (budget - secondRoundExtra - outputs) / 2
}

function needOf(promptTokens: number, rounds: number, requests: number, capabilities: ModelCapabilities, body: WireRequest, context: EligibilityContext): QuotaNeed {
  const outputReserve = outputReserveOf(body, capabilities, context)
  const secondRoundExtra = TOOL_CALL_MESSAGE_TOKENS + context.routing.toolResultReserveTokens
  const input = rounds === 2 ? 2 * promptTokens + secondRoundExtra : promptTokens
  const output = rounds === 2 ? Math.min(outputReserve, TOOL_CALL_OUTPUT_TOKENS) + outputReserve : outputReserve
  const inputTokens = Math.ceil(input * context.routing.tokenSafetyMargin)
  return { requests, inputTokens, totalTokens: inputTokens + output }
}

function outputReserveOf(body: WireRequest, capabilities: ModelCapabilities, context: EligibilityContext): number {
  const requested = [body.max_completion_tokens, body.max_tokens].find((value): value is number => typeof value === 'number' && value > 0)
  return Math.min(requested ?? context.alias.outputReserveTokens, capabilities.maxOutput)
}
