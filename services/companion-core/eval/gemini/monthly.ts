import type { Price } from './accounting'
import type { Sample } from './runner'

import { costNano } from './accounting'
import { PRICES } from './corpus'

interface MeasuredTurn {
  visible: number
  thinking: number
  n: number
}

const LEVELS = [
  { name: 'light', activeMinutes: 30, chatMinutes: 30, watchHours: 0, inputRange: [3000, 6000], visionMax: 2, reasoningMax: 2 },
  { name: 'moderate', activeMinutes: 120, chatMinutes: 60, watchHours: 1, inputRange: [4000, 12_000], visionMax: 6, reasoningMax: 6 },
  { name: 'heavy', activeMinutes: 240, chatMinutes: 120, watchHours: 2, inputRange: [8000, 25_000], visionMax: 12, reasoningMax: 12 },
] as const

function requestCost(price: Price, input: number, output: number): number {
  return costNano(price, { input, cached: 0, output, thinking: 0 }) / 1e9
}

/** Projects explicit usage assumptions. Reported short-turn output anchors the estimate. Context ranges include tool schemas and memory. */
export function projectMonthly(model: 'gemini-3.1-flash-lite' | 'gemini-3.8-flash', measured: MeasuredTurn, flashMultiplier = 1) {
  if (![1, 2].includes(flashMultiplier) || measured.n < 1)
    throw new Error('Unknown monthly assumptions')
  const flash: Price = { input: PRICES['gemini-3.8-flash'].input * flashMultiplier, cached: PRICES['gemini-3.8-flash'].cached * flashMultiplier, output: PRICES['gemini-3.8-flash'].output * flashMultiplier }
  const primary = model === 'gemini-3.8-flash' ? flash : PRICES[model]
  return LEVELS.map((level) => {
    const calculate = (high: boolean) => {
      const days = 30
      const input = level.inputRange[high ? 1 : 0]
      const generated = Math.ceil(measured.visible * (high ? 2 : 1) + measured.thinking * (high ? 2 : 1) + (high ? 64 : 0))
      const chatTurns = days * level.chatMinutes * (high ? 2 : 1)
      // Ten percent of turns use one extra round. At the upper bound, twenty percent use two extra rounds.
      const toolContinuations = chatTurns * (high ? 0.4 : 0.1)
      const watchReactions = high ? days * level.watchHours * 6 : 0
      const visionRequests = high ? days * level.visionMax : 0
      const reasoningRequests = high ? days * level.reasoningMax : 0
      const chatUsd = (chatTurns + toolContinuations) * requestCost(primary, input, generated)
      const watchUsd = watchReactions * requestCost(primary, input, generated)
      // The vision fixture used 1,108 input tokens. Add 500 for observation instructions and synthetic context.
      const visionUsd = visionRequests * requestCost(flash, 1608, 50)
      // Medium thinking used about 443 generated tokens per turn. Round up to 500 for this separate reasoning workload.
      const reasoningUsd = reasoningRequests * requestCost(flash, 2000, 500)
      const geminiUsd = chatUsd + watchUsd + visionUsd + reasoningUsd
      const retryReserveUsd = geminiUsd * 0.1
      const voiceTurns = chatTurns * 0.7
      // Groq Whisper Turbo bills at least ten seconds per request. Only submitted speech clips incur this cost.
      const sttUsd = voiceTurns * (high ? 12 : 10) / 3600 * 0.04
      return {
        chatTurns,
        toolContinuations,
        watchReactions,
        visionRequests,
        reasoningRequests,
        inputTokensPerChatRequest: input,
        generatedTokensPerChatRequest: generated,
        chatUsd,
        watchUsd,
        visionUsd,
        reasoningUsd,
        geminiUsd,
        retryReserveUsd,
        sttUsd,
        localTtsUsd: 0,
        totalUsd: geminiUsd + retryReserveUsd + sttUsd,
      }
    }
    return { ...level, low: calculate(false), high: calculate(true) }
  })
}

/** Generates cost evidence from observed multi-turn responses. Sparse smoke runs omit unmeasured projections. */
export function monthlyCosts(samples: Sample[]) {
  const variants = [
    { model: 'gemini-3.1-flash-lite', effort: 'minimal' },
    { model: 'gemini-3.8-flash', effort: 'low' },
  ] as const
  const projections = variants.flatMap((variant) => {
    const rows = samples.filter(sample => sample.model === variant.model && sample.reasoningEffort === variant.effort && sample.path === 'gateway-paid' && sample.scenario.startsWith('persona/') && sample.usage)
    if (!rows.length)
      return []
    const measured = {
      n: rows.length,
      visible: rows.reduce((sum, row) => sum + row.usage!.output - row.usage!.thinking, 0) / rows.length,
      thinking: rows.reduce((sum, row) => sum + row.usage!.thinking, 0) / rows.length,
    }
    return [{ ...variant, measured, current: projectMonthly(variant.model, measured), january2027: projectMonthly(variant.model, measured, 2) }]
  })
  return {
    schemaVersion: 1,
    projections,
    assumptions: { days: 30, userTurnsPerChatMinute: [1, 2], voiceShare: 0.7, minimumSttSeconds: 10, sttUsdPerHour: 0.04, cachedFraction: 0, retryCostReserve: 0.1, promotionalCreditConfirmed: false },
    limitations: ['Context and admission frequencies are explicit assumptions, not measured user behavior.', 'Local TTS has no metered API charge. Electricity and hardware costs are excluded.', 'Taxes, currency conversion, explicit cache storage, and paid grounding are excluded.', 'The optional reasoning projection does not enable Director or proactive speech.'],
  }
}
