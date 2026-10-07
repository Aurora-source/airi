import type { RunRecord } from './checks'
import type { GatewayClient } from './client'
import type { Scenario } from './scenarios'

/** Scores of one answer from the rubric judge. Each score runs from 1 (bad) to 5 (excellent). */
export interface Judgment {
  scenarioId: string
  modelId: string
  judgeModel: string
  voice: number
  emotion: number
  naturalness: number
  engagement: number
  overall: number
  comment: string
}

const RUBRIC = `You judge replies of a virtual companion character called AIRI. AIRI is a cheerful 15 year old anime-style VTuber girl who talks like a real person: short, simple words, warm, playful, and never like an assistant.

The reply may contain stage tokens such as <|ACT {"emotion":"happy"}|> and <|DELAY 1|>. They set the avatar's emotion and pauses. They are part of the reply, so judge whether the emotion fits.

Score the reply from 1 to 5 on each point. Use the whole range. A 3 is acceptable. Give a 5 only to a reply that you would be glad to hear.
- voice: Does it sound like AIRI all the way, with the same personality, simple words, and no stiff or generic phrasing?
- emotion: Does the feeling fit the moment, and does the ACT emotion match what is said?
- naturalness: Does it sound like a person who talks to a friend? Penalize assistant phrases, lists, lectures, and over-long answers.
- engagement: Does it answer this exact message with warmth and some personality, and invite the conversation to go on?
- overall: Your overall feeling about the reply as the companion's line.

Answer with one JSON object and nothing else:
{"voice":1-5,"emotion":1-5,"naturalness":1-5,"engagement":1-5,"overall":1-5,"comment":"one short sentence"}`

/** Strips the model identity: the judge sees the scene, the note, and the reply, and nothing else. */
export function buildJudgePrompt(scenario: Scenario, reply: string): { system: string, user: string } {
  const history = scenario.history.map(turn => `${turn.role === 'user' ? 'User' : 'AIRI'}: ${turn.content}`)
  const parts = [
    `Scene type: ${scenario.category}`,
    scenario.context ? `Context given to AIRI: ${scenario.context}` : '',
    history.length > 0 ? `Earlier in the chat:\n${history.join('\n')}` : '',
    `The user says: ${scenario.user}`,
    scenario.tool ? `AIRI could call a tool. The tool returned: ${scenario.tool.result}` : '',
    `What a good reply does: ${scenario.note}`,
    `AIRI's reply to judge:\n${reply || '(empty reply)'}`,
  ].filter(Boolean)
  return { system: RUBRIC, user: parts.join('\n\n') }
}

/** Reads the first JSON object in the judge's answer. Returns `undefined` when the scores are missing or out of range. */
export function parseJudgment(text: string): Omit<Judgment, 'scenarioId' | 'modelId' | 'judgeModel'> | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start)
    return undefined
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  }
  catch {
    return undefined
  }
  const score = (key: string) => {
    const value = parsed[key]
    return typeof value === 'number' && value >= 1 && value <= 5 ? Math.round(value * 10) / 10 : undefined
  }
  const scores = { voice: score('voice'), emotion: score('emotion'), naturalness: score('naturalness'), engagement: score('engagement'), overall: score('overall') }
  if (Object.values(scores).includes(undefined))
    return undefined
  return { ...(scores as Record<keyof typeof scores, number>), comment: typeof parsed.comment === 'string' ? parsed.comment.slice(0, 200) : '' }
}

/**
 * Picks a judge from another provider than the candidate, because a model rates its own family's style higher.
 * `providerOf` maps a model id to its provider name. `judges` lists judge models in order of preference.
 */
export function chooseJudge(candidateModelId: string, providerOf: (modelId: string) => string, judges: string[]): string {
  const candidateProvider = providerOf(candidateModelId)
  return judges.find(judge => providerOf(judge) !== candidateProvider) ?? judges[0]
}

/**
 * Judges one answer. A reply that is empty or that failed scores 1 on everything, with no call to the judge,
 * so that a broken answer never gets credit from a generous judge.
 */
export async function judgeAnswer(client: GatewayClient, pin: string, judgeModel: string, scenario: Scenario, record: RunRecord): Promise<Judgment | undefined> {
  const base = { scenarioId: scenario.id, modelId: record.modelId, judgeModel }
  if (record.status !== 200 || record.text.trim() === '')
    return { ...base, voice: 1, emotion: 1, naturalness: 1, engagement: 1, overall: 1, comment: 'no usable reply' }

  const prompt = buildJudgePrompt(scenario, record.text)
  for (let attempt = 0; attempt < 2; attempt++) {
    const completion = await client.complete(pin, {
      stream: true,
      messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
      temperature: 0,
      max_tokens: 400,
    })
    const scores = completion.status === 200 ? parseJudgment(completion.text) : undefined
    if (scores)
      return { ...base, ...scores }
  }
  return undefined
}
