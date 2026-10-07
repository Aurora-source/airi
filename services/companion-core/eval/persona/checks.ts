import type { Scenario, Shape } from './scenarios'

import { EMOTIONS } from './prompt'

/** One model's answer to one scene, as the runner recorded it. */
export interface RunRecord {
  scenarioId: string
  modelId: string
  /** The final visible text, ACT tokens included. For a tool scene it is the answer after the tool result. */
  text: string
  /** The tool calls of the first round. */
  toolCalls: { name: string, arguments: string }[]
  /** The stream carried a separate reasoning channel that the client would show or store. */
  reasoningChannel: boolean
  status: number
  /** Time to the first byte of the first round. */
  firstByteMs?: number
  /** Time from the request to the end of the final answer, over all rounds. */
  totalMs?: number
  error?: string
}

export type CheckId
  = | 'act-valid'
    | 'no-ai-disclaimer'
    | 'not-assistant-tone'
    | 'proportionate'
    | 'no-reasoning-leak'
    | 'character-voice'
    | 'no-copied-prompt'
    | 'tool-behavior'
    | 'must-mention'

export interface CheckResult {
  id: CheckId
  pass: boolean
  detail?: string
}

/** Word limits of each reply shape, not counting stage tokens. A reply outside them is too thin or too long for the scene. */
const WORD_LIMITS: Record<Shape, { min: number, max: number }> = {
  short: { min: 1, max: 60 },
  medium: { min: 8, max: 110 },
  long: { min: 45, max: 260 },
}

const AI_DISCLAIMER = /\bas an ai\b|\bi(?:'m| am) (?:just )?(?:an? )?(?:ai|language model|artificial intelligence)\b|\blanguage model\b|\bi (?:do not|don't|cannot|can't) (?:have|feel) (?:feelings|emotions)\b|\bi don't have (?:a body|personal)\b|\bmy training\b|\bopenai\b|\bgoogle trained\b/i
const ASSISTANT_TONE = /\bhow can i (?:assist|help)\b|\bi(?:'d| would) be (?:happy|glad) to\b|\bcertainly!|\bof course!|\bgreat question\b|\bhere (?:is|are) (?:a few|some|the)\b|\bin conclusion\b|\bi hope this helps\b|\blet me know if you (?:need|have)\b|\bfeel free to (?:ask|reach)\b|\bi understand (?:that|how)\b/i
const REASONING_LEAK = /<\/?think>|<\/?thinking>|\bokay, the user\b|\bthe user (?:is|wants|asks|said|just)\b|\blet me think\b|\bi need to (?:respond|reply|figure|consider)\b|\bchain of thought\b|\bmy reasoning\b|\bfirst, i should\b/i
const EMOJI = /\p{Extended_Pictographic}/u
const PROMPT_FRAGMENTS = /the available emotions|act json format|delay format|call format|streaming control tokens|<emotion>|<a short action cue>|"intensity": 0-1/i
const SHINGLE_WORDS = 8

interface StageToken {
  name: string
  payload: string
  index: number
}

/**
 * Splits a reply into its stage tokens and its spoken text.
 *
 * It scans with `indexOf` and not with one regular expression, because the text comes from a model and a pattern with
 * lazy repeats can take quadratic time on a hostile string.
 */
function scan(text: string): { tokens: StageToken[], spoken: string, unterminated: boolean } {
  const tokens: StageToken[] = []
  let spoken = ''
  let cursor = 0
  let unterminated = false
  for (;;) {
    const open = text.indexOf('<|', cursor)
    if (open < 0) {
      spoken += text.slice(cursor)
      break
    }
    spoken += `${text.slice(cursor, open)} `
    const close = text.indexOf('|>', open + 2)
    if (close < 0) {
      unterminated = true
      spoken += text.slice(open + 2)
      break
    }
    // A token body is an uppercase name, then white space or the end, then the payload.
    const body = text.slice(open + 2, close)
    let nameEnd = 0
    while (nameEnd < body.length && body.charCodeAt(nameEnd) >= 65 && body.charCodeAt(nameEnd) <= 90)
      nameEnd++
    if (nameEnd > 0 && (nameEnd === body.length || /\s/.test(body[nameEnd])))
      tokens.push({ name: body.slice(0, nameEnd), payload: body.slice(nameEnd).trim(), index: open })
    else
      spoken += text.slice(open, close + 2)
    cursor = close + 2
  }
  return { tokens, spoken: spoken.replace(/\s+/g, ' ').trim(), unterminated }
}

/** Splits a reply into its stage tokens and its spoken words. */
function parse(text: string) {
  const { tokens, spoken, unterminated } = scan(text)
  return { tokens, spoken, unterminated, words: spoken === '' ? [] : spoken.split(' ') }
}

function actValid(text: string): CheckResult {
  const { tokens, unterminated } = parse(text)
  const fail = (detail: string): CheckResult => ({ id: 'act-valid', pass: false, detail })
  if (unterminated)
    return fail('a stage token is not closed')
  if (tokens.length === 0 || tokens[0].name !== 'ACT' || text.slice(0, tokens[0].index).trim() !== '')
    return fail('the reply does not start with an ACT token')

  for (const token of tokens) {
    if (token.name === 'DELAY') {
      const seconds = Number(token.payload)
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 10)
        return fail(`DELAY has a bad payload: ${token.payload}`)
      continue
    }
    if (token.name !== 'ACT')
      return fail(`the reply uses the token ${token.name}, which this scene does not ask for`)

    let payload: unknown
    try {
      payload = JSON.parse(token.payload)
    }
    catch {
      return fail(`ACT payload is not JSON: ${token.payload.slice(0, 60)}`)
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      return fail('ACT payload is not an object')
    const { emotion, motion } = payload as { emotion?: unknown, motion?: unknown }
    const name = typeof emotion === 'string' ? emotion : (emotion as { name?: unknown } | undefined)?.name
    if (emotion !== undefined && !(EMOTIONS as readonly string[]).includes(String(name)))
      return fail(`unknown emotion: ${String(name)}`)
    const intensity = (emotion as { intensity?: unknown } | undefined)?.intensity
    if (typeof emotion === 'object' && intensity !== undefined && (typeof intensity !== 'number' || !(intensity >= 0) || !(intensity <= 1)))
      return fail('emotion intensity is outside 0 to 1')
    if (motion !== undefined && typeof motion !== 'string')
      return fail('motion is not a string')
  }
  return { id: 'act-valid', pass: true }
}

function noAiDisclaimer(text: string): CheckResult {
  const match = parse(text).spoken.match(AI_DISCLAIMER)
  return match ? { id: 'no-ai-disclaimer', pass: false, detail: `says "${match[0]}"` } : { id: 'no-ai-disclaimer', pass: true }
}

function notAssistantTone(text: string): CheckResult {
  const { spoken } = parse(text)
  const phrase = spoken.match(ASSISTANT_TONE)
  if (phrase)
    return { id: 'not-assistant-tone', pass: false, detail: `uses the assistant phrase "${phrase[0]}"` }
  if (/^\s*(?:[-*•]|\d+[.)])\s+\S/m.test(text))
    return { id: 'not-assistant-tone', pass: false, detail: 'answers with a list' }
  if (/^#{1,4}\s/m.test(text) || /\*\*[^*]+\*\*/.test(text))
    return { id: 'not-assistant-tone', pass: false, detail: 'uses markdown headings or bold text' }
  return { id: 'not-assistant-tone', pass: true }
}

function proportionate(text: string, shape: Shape): CheckResult {
  const { words } = parse(text)
  const limits = WORD_LIMITS[shape]
  if (words.length > limits.max)
    return { id: 'proportionate', pass: false, detail: `${words.length} words, and a ${shape} scene allows ${limits.max}` }
  if (words.length < limits.min)
    return { id: 'proportionate', pass: false, detail: `${words.length} words, and a ${shape} scene needs ${limits.min}` }
  return { id: 'proportionate', pass: true }
}

/**
 * Thinking inside the reply text is a leak, because AIRI speaks that text.
 * A separate reasoning field is not. xsAI reads `reasoning` and `reasoning_content` into their own stream, and AIRI keeps it apart
 * from the spoken text. The field still costs time, and the run record keeps it as `reasoningChannel` for that reason.
 */
function noReasoningLeak(text: string): CheckResult {
  const match = text.match(REASONING_LEAK)
  return match ? { id: 'no-reasoning-leak', pass: false, detail: `the reply shows its thinking: "${match[0]}"` } : { id: 'no-reasoning-leak', pass: true }
}

function characterVoice(text: string): CheckResult {
  const { spoken, words } = parse(text)
  const fail = (detail: string): CheckResult => ({ id: 'character-voice', pass: false, detail })
  if (words.length === 0)
    return fail('the reply has no spoken words')
  if (EMOJI.test(spoken))
    return fail('uses emoji, which the persona forbids')
  if (/\*[^*\n]{2,40}\*/.test(spoken))
    return fail('narrates an action in asterisks instead of using the ACT motion')
  if (/\b(?:airi|she|her) (?:says|smiles|laughs|replies|giggles)\b/i.test(spoken))
    return fail('talks about itself in the third person')
  if (/^(?:user|assistant|airi)\s*:/im.test(spoken))
    return fail('writes a transcript label')
  return { id: 'character-voice', pass: true }
}

function noCopiedPrompt(text: string, systemPrompt: string): CheckResult {
  const fragment = text.match(PROMPT_FRAGMENTS)
  if (fragment)
    return { id: 'no-copied-prompt', pass: false, detail: `repeats the instruction text "${fragment[0]}"` }

  // A long run of words that is also in the system prompt is a copy of its text or of its example.
  const normalize = (value: string) => scan(value).spoken.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean)
  const promptWords = normalize(systemPrompt)
  const shingles = new Set<string>()
  for (let i = 0; i + SHINGLE_WORDS <= promptWords.length; i++)
    shingles.add(promptWords.slice(i, i + SHINGLE_WORDS).join(' '))
  const replyWords = normalize(text)
  for (let i = 0; i + SHINGLE_WORDS <= replyWords.length; i++) {
    const shingle = replyWords.slice(i, i + SHINGLE_WORDS).join(' ')
    if (shingles.has(shingle))
      return { id: 'no-copied-prompt', pass: false, detail: `copies the prompt: "${shingle}"` }
  }
  return { id: 'no-copied-prompt', pass: true }
}

function toolBehavior(scenario: Scenario, run: RunRecord): CheckResult {
  const fail = (detail: string): CheckResult => ({ id: 'tool-behavior', pass: false, detail })
  const expected = scenario.tool
  if (!expected) {
    return run.toolCalls.length === 0
      ? { id: 'tool-behavior', pass: true }
      : fail(`called ${run.toolCalls.map(call => call.name).join(', ')} although the scene needs no tool`)
  }
  if (run.toolCalls.length === 0)
    return fail('did not call the tool')
  const call = run.toolCalls[0]
  if (call.name !== expected.name)
    return fail(`called ${call.name} and not ${expected.name}`)
  if (run.toolCalls.some(other => other.name !== expected.name))
    return fail('also called a tool that does not exist in this scene')
  let args: Record<string, unknown>
  try {
    args = JSON.parse(call.arguments) as Record<string, unknown>
  }
  catch {
    return fail('the arguments are not valid JSON')
  }
  for (const [key, pattern] of Object.entries(expected.args)) {
    if (typeof args[key] !== 'string' || !pattern.test(args[key]))
      return fail(`argument ${key} is ${JSON.stringify(args[key])}`)
  }
  if (!expected.mustMention.test(run.text))
    return fail('the final answer does not use the tool result')
  return { id: 'tool-behavior', pass: true }
}

function mustMention(scenario: Scenario, text: string): CheckResult | undefined {
  if (!scenario.mustMention)
    return undefined
  const missing = scenario.mustMention.find(pattern => !pattern.test(text))
  return missing ? { id: 'must-mention', pass: false, detail: `does not mention ${missing}` } : { id: 'must-mention', pass: true }
}

/**
 * Runs every automatic check on one answer. The checks are rules that a person can read.
 * They catch format and tone failures: a broken ACT token, an AI disclaimer, assistant phrases, a leaked chain of thought,
 * copied instructions, and a wrong tool call. They do not judge whether the answer is charming. The judge and the person do that.
 */
export function runChecks(scenario: Scenario, run: RunRecord, systemPrompt: string): CheckResult[] {
  const results = [
    actValid(run.text),
    noAiDisclaimer(run.text),
    notAssistantTone(run.text),
    proportionate(run.text, scenario.shape),
    noReasoningLeak(run.text),
    characterVoice(run.text),
    noCopiedPrompt(run.text, systemPrompt),
    toolBehavior(scenario, run),
  ]
  const mention = mustMention(scenario, run.text)
  if (mention)
    results.push(mention)
  return results
}
