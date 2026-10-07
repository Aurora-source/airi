import type { CheckId } from './checks'
import type { Judgment } from './judge'
import type { ResultRow } from './runner'

/** What the configuration says about a model, for the practicality columns. */
export interface ModelFacts {
  id: string
  provider: string
  contextWindow: number
  rpd?: number
  tpd?: number
  tpm?: number
  structuredOutput: boolean
}

export interface ModelSummary {
  modelId: string
  scenes: number
  /** Scenes that returned an answer. */
  answered: number
  failureRate: number
  /** Share of all automatic checks that passed. */
  autoPassRate: number
  actCorrectness: number
  toolCorrectness: number
  perCheck: Partial<Record<CheckId, number>>
  judged: number
  judge: { voice: number, emotion: number, naturalness: number, engagement: number, overall: number } | undefined
  /** 0 to 100. The judge counts 60% and the automatic checks 40%. */
  personaScore: number
  firstByteMs: number | undefined
  totalMs: number | undefined
  /** How many AIRI turns per day the free-tier limits allow, at a real AIRI prompt size of about 5k tokens. */
  turnsPerDay: number | undefined
  meanPromptTokens: number | undefined
  facts: ModelFacts
}

function median(values: number[]): number | undefined {
  if (values.length === 0)
    return undefined
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}
const mean = (values: number[]): number | undefined => values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length

/**
 * Turns the rows and the judgments into one summary per model.
 *
 * The persona score is a decision aid and not a verdict: 60% judge overall, scaled to 100, and 40% automatic pass rate.
 * Without judgments, the automatic pass rate stands alone. The blind ranking of the user outranks it.
 */
export function summarize(rows: ResultRow[], judgments: Judgment[], facts: ModelFacts[], sceneCount: number, airiPromptTokens = 5000): ModelSummary[] {
  return facts.map((model) => {
    const mine = rows.filter(row => row.modelId === model.id)
    const answered = mine.filter(row => row.record.status === 200 && row.record.text.trim() !== '')
    // A refused request has no reply to check. It counts in the failure rate and in capacity, and not as a broken format.
    const allChecks = answered.flatMap(row => row.checks)
    const rate = (id: CheckId) => {
      const relevant = answered.flatMap(row => row.checks.filter(check => check.id === id))
      return relevant.length === 0 ? undefined : relevant.filter(check => check.pass).length / relevant.length
    }
    const perCheck: Partial<Record<CheckId, number>> = {}
    for (const id of new Set(allChecks.map(check => check.id)))
      perCheck[id] = rate(id)

    // The judge scores taste. A refused scene has no reply to taste, so it does not pull the average down. The failure rate shows it.
    const answeredScenes = new Set(answered.map(row => row.scenarioId))
    const scores = judgments.filter(judgment => judgment.modelId === model.id && answeredScenes.has(judgment.scenarioId))
    const judge = scores.length === 0
      ? undefined
      : {
          voice: mean(scores.map(score => score.voice))!,
          emotion: mean(scores.map(score => score.emotion))!,
          naturalness: mean(scores.map(score => score.naturalness))!,
          engagement: mean(scores.map(score => score.engagement))!,
          overall: mean(scores.map(score => score.overall))!,
        }
    const autoPassRate = allChecks.length === 0 ? 0 : allChecks.filter(check => check.pass).length / allChecks.length
    const personaScore = judge ? 0.6 * (judge.overall / 5) * 100 + 0.4 * autoPassRate * 100 : autoPassRate * 100

    const promptTokens = mine.map(row => row.usage?.promptTokens).filter((value): value is number => typeof value === 'number')
    const meanPromptTokens = mean(promptTokens)
    // The scenes use small prompts. A real AIRI request is about 5k tokens with its tools, plus a tool round in a tenth of the turns.
    const dailyByTokens = model.tpd === undefined ? undefined : Math.floor(model.tpd / (airiPromptTokens * 1.1))
    const turnsPerDay = [model.rpd, dailyByTokens].filter((value): value is number => value !== undefined)

    return {
      modelId: model.id,
      scenes: sceneCount,
      answered: answered.length,
      failureRate: sceneCount === 0 ? 0 : 1 - answered.length / sceneCount,
      autoPassRate,
      actCorrectness: rate('act-valid') ?? 0,
      toolCorrectness: rate('tool-behavior') ?? 0,
      perCheck,
      judged: scores.length,
      judge,
      personaScore,
      firstByteMs: median(answered.map(row => row.record.firstByteMs).filter((value): value is number => typeof value === 'number')),
      totalMs: median(answered.map(row => row.record.totalMs).filter((value): value is number => typeof value === 'number')),
      turnsPerDay: turnsPerDay.length === 0 ? undefined : Math.min(...turnsPerDay),
      meanPromptTokens,
      facts: model,
    }
  })
}

/** Gates for a model to head the ConversationModel chain. They guard the basics before taste decides. */
export const CONVERSATION_GATES = { minActCorrectness: 0.9, minToolCorrectness: 2 / 3, maxFailureRate: 0.1 }

export function passesConversationGates(summary: ModelSummary): boolean {
  return summary.actCorrectness >= CONVERSATION_GATES.minActCorrectness
    && summary.toolCorrectness >= CONVERSATION_GATES.minToolCorrectness
    && summary.failureRate <= CONVERSATION_GATES.maxFailureRate
}

/** Orders the models that pass the gates by persona score. The others follow, so that nothing is hidden. */
export function rankConversation(summaries: ModelSummary[]): ModelSummary[] {
  const byScore = (a: ModelSummary, b: ModelSummary) => b.personaScore - a.personaScore || (a.firstByteMs ?? Infinity) - (b.firstByteMs ?? Infinity)
  return [...summaries.filter(passesConversationGates).sort(byScore), ...summaries.filter(summary => !passesConversationGates(summary)).sort(byScore)]
}

/**
 * Orders models for background reasoning work, which needs no persona: structured output, correct tool use,
 * few failures, daily capacity, and speed. Scores add up, and each part is worth the same.
 */
export function rankReasoning(summaries: ModelSummary[]): ModelSummary[] {
  const maxCapacity = Math.max(1, ...summaries.map(summary => summary.turnsPerDay ?? 0))
  const maxSpeed = Math.max(1, ...summaries.map(summary => summary.totalMs ?? 0))
  const score = (summary: ModelSummary) =>
    (summary.facts.structuredOutput ? 1 : 0)
    + summary.toolCorrectness
    + (1 - summary.failureRate)
    + (summary.turnsPerDay ?? 0) / maxCapacity
    + (1 - (summary.totalMs ?? maxSpeed) / maxSpeed)
  return [...summaries].sort((a, b) => score(b) - score(a))
}
