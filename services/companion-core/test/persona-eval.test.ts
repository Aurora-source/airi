import type { ResultRow } from '../eval/persona/runner'

import { describe, expect, it } from 'vitest'

import { passesConversationGates, rankConversation, rankReasoning, summarize } from '../eval/persona/aggregate'
import { buildBlindPackage, scoreBlind } from '../eval/persona/blind'
import { buildJudgePrompt, chooseJudge, judgeAnswer, parseJudgment } from '../eval/persona/judge'
import { SCENARIOS } from '../eval/persona/scenarios'

const scene = (id: string) => SCENARIOS.find(scenario => scenario.id === id)!

function row(scenarioId: string, modelId: string, text: string, extra: Partial<ResultRow['record']> = {}, checks: ResultRow['checks'] = []): ResultRow {
  return { scenarioId, modelId, record: { scenarioId, modelId, text, toolCalls: [], reasoningChannel: false, status: 200, firstByteMs: 300, totalMs: 900, ...extra }, checks, waitedMs: 0, usage: { promptTokens: 1200 } }
}

describe('judge', () => {
  it('shows the judge the scene and the reply and never a model name', () => {
    const prompt = buildJudgePrompt(scene('memory-1'), '<|ACT {"emotion":"happy"}|> You got it?! Your interview went well!')

    expect(prompt.user).toContain('guess what, I got the job!')
    expect(prompt.user).toContain('Your interview went well!')
    expect(prompt.user).toContain('What a good reply does')
    expect(prompt.system).toContain('"overall":1-5')
    expect(JSON.stringify(prompt)).not.toMatch(/gemini|groq|qwen|gpt-oss|gemma/i)
  })

  it('reads the scores from an answer with text around the JSON', () => {
    const parsed = parseJudgment('Sure! {"voice":4,"emotion":5,"naturalness":3.5,"engagement":4,"overall":4,"comment":"Warm and short."} Hope that helps.')

    expect(parsed).toEqual({ voice: 4, emotion: 5, naturalness: 3.5, engagement: 4, overall: 4, comment: 'Warm and short.' })
  })

  it.each([
    ['no JSON', 'The reply is nice.'],
    ['a missing score', '{"voice":4,"emotion":5,"naturalness":3,"engagement":4}'],
    ['a score out of range', '{"voice":9,"emotion":5,"naturalness":3,"engagement":4,"overall":4}'],
    ['a score that is text', '{"voice":"high","emotion":5,"naturalness":3,"engagement":4,"overall":4}'],
  ])('rejects %s', (_name, text) => {
    expect(parseJudgment(text)).toBeUndefined()
  })

  it('picks a judge from another provider than the candidate', () => {
    const providerOf = (id: string) => id.startsWith('gemini') ? 'gemini' : 'groq'

    expect(chooseJudge('gemini-flash', providerOf, ['groq-oss-120b', 'gemini-flash-lite'])).toBe('groq-oss-120b')
    expect(chooseJudge('groq-qwen', providerOf, ['groq-oss-120b', 'gemini-flash-lite'])).toBe('gemini-flash-lite')
  })

  it('gives a failed or empty answer the lowest score without calling any judge', async () => {
    const client = {
      complete: () => {
        throw new Error('the judge must not be called')
      },
    }

    const judgment = await judgeAnswer(client as never, 'pin', 'judge', scene('casual-1'), row('casual-1', 'm', '').record)

    expect(judgment).toMatchObject({ overall: 1, comment: 'no usable reply' })
  })
})

describe('summarize and rank', () => {
  const pass = (id: string, ok = true) => ({ id, pass: ok }) as ResultRow['checks'][number]
  const facts = (id: string, extra = {}) => ({ id, provider: id.startsWith('g') ? 'gemini' : 'groq', contextWindow: 100_000, structuredOutput: true, ...extra })

  const rows: ResultRow[] = [
    row('casual-1', 'good', 'a', {}, [pass('act-valid'), pass('tool-behavior')]),
    row('casual-2', 'good', 'b', {}, [pass('act-valid'), pass('tool-behavior')]),
    row('casual-1', 'broken-act', 'a', {}, [pass('act-valid', false), pass('tool-behavior')]),
    row('casual-2', 'broken-act', 'b', {}, [pass('act-valid', false), pass('tool-behavior')]),
    row('casual-1', 'fast', 'a', { firstByteMs: 100, totalMs: 200 }, [pass('act-valid'), pass('tool-behavior')]),
    row('casual-2', 'fast', 'b', { firstByteMs: 100, totalMs: 200 }, [pass('act-valid'), pass('tool-behavior')]),
  ]
  const judgments = ['good', 'broken-act', 'fast'].flatMap(modelId => ['casual-1', 'casual-2'].map(scenarioId => ({ scenarioId, modelId, judgeModel: 'j', voice: 4, emotion: 4, naturalness: 4, engagement: 4, overall: modelId === 'good' ? 5 : 3, comment: '' })))

  it('combines the judge at 60% and the automatic checks at 40%', () => {
    const [good] = summarize(rows, judgments, [facts('good')], 2)

    expect(good.personaScore).toBeCloseTo(0.6 * 100 + 0.4 * 100, 5)
    expect(good.actCorrectness).toBe(1)
    expect(good.firstByteMs).toBe(300)
  })

  it('computes the daily capacity from the request limit and the token limit, at the measured prompt size', () => {
    const [model] = summarize(rows, judgments, [facts('good', { rpd: 1000, tpd: 200_000 })], 2)

    expect(model.turnsPerDay).toBe(Math.floor(200_000 / (1200 * 1.1)))
  })

  it('keeps a model with broken ACT tokens out of the head of the chain, however well it scores', () => {
    const summaries = summarize(rows, judgments, [facts('broken-act'), facts('good'), facts('fast')], 2)

    expect(passesConversationGates(summaries[0])).toBe(false)
    expect(rankConversation(summaries).map(summary => summary.modelId)).toEqual(['good', 'fast', 'broken-act'])
  })

  it('counts a scene without an answer as a failure', () => {
    const [good] = summarize(rows, judgments, [facts('good')], 4)

    expect(good.failureRate).toBe(0.5)
    expect(passesConversationGates(good)).toBe(false)
  })

  it('ranks reasoning models by structure, tools, reliability, capacity, and speed, and not by persona', () => {
    const summaries = summarize(rows, judgments, [facts('fast', { structuredOutput: false }), facts('good', { structuredOutput: true })], 2)

    expect(rankReasoning(summaries)[0].modelId).toBe('good')
  })
})

describe('blind package', () => {
  const rows = [
    row('casual-1', 'alpha', '<|ACT {"emotion":"happy"}|> Welcome back from alpha!'),
    row('casual-1', 'beta', '<|ACT {"emotion":"happy"}|> Welcome back from beta!'),
    row('casual-1', 'gamma', '<|ACT {"emotion":"happy"}|> Welcome back from gamma!'),
    row('casual-2', 'alpha', '<|ACT {"emotion":"happy"}|> Ramen!'),
    row('casual-2', 'beta', '<|ACT {"emotion":"happy"}|> Curry!'),
    row('casual-3', 'alpha', '<|ACT {"emotion":"happy"}|> Only one model answered this scene.'),
  ]
  const scenarios = [scene('casual-1'), scene('casual-2'), scene('casual-3')]

  it('lists only the scenes that at least two models answered', () => {
    const { key } = buildBlindPackage(scenarios, rows, 7)

    expect(Object.keys(key.scenarios)).toEqual(['casual-1', 'casual-2'])
  })

  it('gives every model one letter in each scene it answered', () => {
    const { key } = buildBlindPackage(scenarios, rows, 7)

    expect(Object.values(key.scenarios['casual-1']).sort()).toEqual(['alpha', 'beta', 'gamma'])
    expect(Object.keys(key.scenarios['casual-1'])).toEqual(['A', 'B', 'C'])
  })

  it('keeps every model name out of the page, and puts the answers in', () => {
    const { html } = buildBlindPackage(scenarios, rows, 7)

    // The answer text of the fake models names them, so the check uses names that appear only as model ids.
    const { html: clean } = buildBlindPackage(scenarios, [
      row('casual-1', 'alpha', '<|ACT {"emotion":"happy"}|> Welcome back!'),
      row('casual-1', 'beta', '<|ACT {"emotion":"happy"}|> I missed you!'),
    ], 7)

    expect(html).toContain('Welcome back from alpha!')
    expect(clean).not.toMatch(/alpha|beta/)
    expect(clean).toContain('persona-blind-ranking-v1')
  })

  it('gives the same shuffle for the same seed and another shuffle for another seed', () => {
    const first = buildBlindPackage(scenarios, rows, 7).key
    const same = buildBlindPackage(scenarios, rows, 7).key
    const orders = new Set(Array.from({ length: 12 }, (_, seed) => JSON.stringify(buildBlindPackage(scenarios, rows, seed).key.scenarios['casual-1'])))

    expect(same).toEqual(first)
    expect(orders.size).toBeGreaterThan(1)
  })

  it('cannot be closed early by an answer that holds a script end tag', () => {
    const { html } = buildBlindPackage(scenarios, [
      row('casual-1', 'alpha', '</script><script>alert(1)</script>'),
      row('casual-1', 'beta', 'fine'),
    ], 1)

    expect(html.match(/<\/script>/g)).toHaveLength(2)
    expect(html).not.toContain('<script>alert(1)')
  })

  it('scores a ranking: mean rank from 0 for always first to 1 for always last, and first places', () => {
    const { key } = buildBlindPackage(scenarios, rows, 7)
    const first = key.scenarios['casual-1']
    const letterOf = (scene: string, model: string) => Object.entries(key.scenarios[scene]).find(([, id]) => id === model)![0]
    const ranks = {
      version: 1 as const,
      ranks: {
        'casual-1': { [letterOf('casual-1', 'beta')]: 1, [letterOf('casual-1', 'alpha')]: 2, [letterOf('casual-1', 'gamma')]: 3 },
        'casual-2': { [letterOf('casual-2', 'beta')]: 1, [letterOf('casual-2', 'alpha')]: 2 },
      },
    }

    const scores = scoreBlind(key, ranks)

    expect(first).toBeDefined()
    expect(scores.map(score => score.modelId)).toEqual(['beta', 'alpha', 'gamma'])
    expect(scores[0]).toMatchObject({ modelId: 'beta', scenes: 2, meanRank: 0, firstPlaces: 2 })
    expect(scores[1].meanRank).toBeCloseTo((0.5 + 1) / 2, 5)
    expect(scores[2]).toMatchObject({ modelId: 'gamma', scenes: 1, meanRank: 1, firstPlaces: 0 })
  })
})
