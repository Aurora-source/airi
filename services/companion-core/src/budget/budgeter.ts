import type { TokenEstimator } from './estimate'
import type { MalformedReason, MessageRange, TurnGroup } from './request-units'
import type { WireMessage, WireRequest } from './wire'

import { createHash } from 'node:crypto'

import { parseConversation } from './request-units'
import { isInstructionRole } from './wire'

/**
 * Where the tokens of one request go. The three gateway-injected blocks are zero until the memory, awareness,
 * and watch phases exist. Their fields are here so that every later phase reports into the same shape.
 */
export interface PromptDiagnostics {
  /** Leading `system` and `developer` messages: the character card and the ACT instructions. */
  systemTokens: number
  /** Every other message, including a recap of dropped history. */
  conversationTokens: number
  /** The `tools` array. Its schemas are often the largest part of an AIRI request. */
  toolSchemaTokens: number
  memoryTokens: number
  awarenessTokens: number
  watchTokens: number
  /** The output reserve: `max_tokens` when the request sets it, else the configured default. */
  estimatedOutputTokens: number
  totalEstimatedTokens: number
}

/** Tokens that the provider reads as input. The output reserve is not part of it. */
export function promptTokensOf(diagnostics: PromptDiagnostics): number {
  return diagnostics.totalEstimatedTokens - diagnostics.estimatedOutputTokens
}

export interface BudgetOptions {
  estimator: TokenEstimator
  /** Largest prompt that the target accepts, tool schemas included. The output reserve is separate. */
  targetTokens: number
  /** Output tokens to reserve when the request has no `max_tokens`. */
  outputReserveTokens: number
  /**
   * When a request is over the target, trim down to this fraction of it. A deeper trim keeps the kept prefix
   * identical across the next requests, so that provider-side prompt caching keeps working.
   *
   * @default 0.85
   */
  lowWaterRatio?: number
  /**
   * Older turns that compaction skips. Compaction removes tool exchanges, so the most recent tool activity stays whole.
   *
   * @default 3
   */
  protectedRecentGroups?: number
  /**
   * `recap` quotes the dropped turns. `notice` only says that turns are missing. `none` adds nothing.
   *
   * @default 'recap'
   */
  summary?: 'recap' | 'notice' | 'none'
  /**
   * @default 500
   */
  summaryMaxTokens?: number
}

export interface TrimReport {
  /** Whole turns that the summary replaces. They are always the oldest turns. */
  droppedGroups: number
  /** Older turns that lost their tool exchanges and keep their user messages and final answers. */
  compactedGroups: number
  /** Indexes, in the original message list, of every message that the trimmed request keeps. */
  keptIndexes: number[]
  /**
   * The injected recap, with the exact original messages that it stands for.
   * No kept message lies inside `coversMessages`, so nothing appears both verbatim and in the recap.
   */
  summary?: { coversMessages: MessageRange, tokens: number, sourceSha256: string }
}

export type BudgetResult
  = | { status: 'fits', body: WireRequest, diagnostics: PromptDiagnostics }
    | { status: 'trimmed', body: WireRequest, diagnostics: PromptDiagnostics, original: PromptDiagnostics, trim: TrimReport }
    /** The history is not valid, or the trim broke an invariant. The request is unchanged and may exceed the target. */
    | { status: 'untrimmed', body: WireRequest, diagnostics: PromptDiagnostics, reason: MalformedReason | 'invariant-violation', detail: string }
    /** System messages, tool schemas, and the current turn alone exceed the target. Nothing is truncated. */
    | { status: 'impossible', diagnostics: PromptDiagnostics, requiredTokens: number }

type GroupMode = 'full' | 'compact' | 'drop'

const DEFAULT_LOW_WATER_RATIO = 0.85
const DEFAULT_PROTECTED_RECENT_GROUPS = 3
const DEFAULT_SUMMARY_MAX_TOKENS = 500
const MAX_SUMMARY_SHARE = 0.1
const NOTICE_TOKENS = 60
const EXCERPT_CHARS = 160

/** Messages that the gateway wrote itself. The invariant check accepts them as the only new messages. */
const injectedMessages = new WeakSet<object>()

/**
 * Fits a chat-completions request to a token target without ever editing a message.
 *
 * The budgeter keeps or drops atomic units. A tool call stays with its results, and a user turn keeps all its parts.
 * It never trims the system messages or the current turn. Order of work when the request is over the target:
 *
 * 1. Compact old turns: drop their tool exchanges and keep their user messages and final answers. The newest turns are skipped.
 * 2. Drop the oldest whole turns and put a recap in their place, right after the system messages.
 * 3. Report `impossible` when the fixed part alone does not fit.
 *
 * A request with a broken tool history is returned as `untrimmed`, so that the gateway never makes it worse.
 *
 * Call stack:
 *
 * budgetRequest
 *   -> {@link parseConversation}
 *     -> trim -> {@link checkContextInvariants}
 */
export function budgetRequest(body: WireRequest, options: BudgetOptions): BudgetResult {
  const { estimator } = options
  const messages = body.messages ?? []
  const costs = messages.map(message => estimator.message(message))
  const toolTokens = body.tools && body.tools.length > 0 ? estimator.json(body.tools) : 0
  const outputTokens = outputReserveOf(body, options.outputReserveTokens)
  const leading = leadingInstructionCount(messages)
  const diagnostics = diagnose(sumCosts(costs, 0, leading), sumCosts(costs, leading, messages.length), toolTokens, outputTokens)

  const parsed = parseConversation(messages)
  if (!parsed.ok)
    return { status: 'untrimmed', body, diagnostics, reason: parsed.reason, detail: parsed.detail }
  if (promptTokensOf(diagnostics) <= options.targetTokens)
    return { status: 'fits', body, diagnostics }

  const groups = parsed.groups
  const current = groups[groups.length - 1]
  const older = groups.slice(0, -1)
  const baseTokens = diagnostics.systemTokens + toolTokens + sumCosts(costs, current.start, current.end)
  if (baseTokens > options.targetTokens)
    return { status: 'impossible', diagnostics, requiredTokens: baseTokens }

  const summaryKind = options.summary ?? 'recap'
  // A recap must not crowd out whole turns when the target is small, so it never takes more than a tenth of the target.
  const summaryMax = Math.min(options.summaryMaxTokens ?? DEFAULT_SUMMARY_MAX_TOKENS, Math.floor(options.targetTokens * MAX_SUMMARY_SHARE))
  let summaryReserve = summaryKind === 'none' ? 0 : summaryKind === 'notice' ? NOTICE_TOKENS : summaryMax

  const fullCosts = older.map(group => sumCosts(costs, group.start, group.end))
  const compactable = older.map(group => (group.assistant?.exchanges.length ?? 0) > 0)
  const compactCosts = older.map((group, i) => {
    if (!compactable[i])
      return fullCosts[i]
    const finalText = group.assistant!.finalTextIndex
    return sumCosts(costs, group.userSide.start, group.userSide.end) + (finalText === undefined ? 0 : costs[finalText])
  })

  const modes: GroupMode[] = older.map(() => 'full')
  const total = () => {
    let sum = baseTokens
    let dropped = false
    for (let i = 0; i < older.length; i++) {
      if (modes[i] === 'drop')
        dropped = true
      else
        sum += modes[i] === 'compact' ? compactCosts[i] : fullCosts[i]
    }
    return sum + (dropped ? summaryReserve : 0)
  }

  const lowWater = Math.max(Math.floor(options.targetTokens * (options.lowWaterRatio ?? DEFAULT_LOW_WATER_RATIO)), baseTokens)

  // Compaction first: tool results are the biggest and the least conversational part of old history.
  const compactUntil = older.length - (options.protectedRecentGroups ?? DEFAULT_PROTECTED_RECENT_GROUPS)
  for (let i = 0; i < compactUntil && total() > lowWater; i++) {
    if (compactable[i])
      modes[i] = 'compact'
  }
  // Then whole turns, oldest first. The dropped turns form one prefix of the history.
  for (let i = 0; i < older.length && total() > lowWater; i++)
    modes[i] = 'drop'

  // The recap reserve can push the request over the target when every older turn is gone. Then the recap goes.
  if (total() > options.targetTokens)
    summaryReserve = 0

  const dropped = older.filter((_, i) => modes[i] === 'drop')
  const compacted = modes.filter(mode => mode === 'compact').length
  const keptIndexes: number[] = []
  const output: WireMessage[] = []
  const keep = (from: number, to: number) => {
    for (let index = from; index < to; index++) {
      keptIndexes.push(index)
      output.push(messages[index])
    }
  }

  keep(0, leading)
  let summary: TrimReport['summary']
  if (dropped.length > 0 && summaryReserve > 0 && summaryKind !== 'none') {
    const covers = { start: dropped[0].start, end: dropped[dropped.length - 1].end }
    const message = buildSummary(messages, dropped, summaryKind, summaryReserve, estimator)
    const tokens = estimator.message(message)
    // The fixed header can be larger than a small reserve. The recap is optional, so the target wins.
    if (total() - summaryReserve + tokens <= options.targetTokens) {
      injectedMessages.add(message)
      output.push(message)
      summary = {
        coversMessages: covers,
        tokens,
        sourceSha256: createHash('sha256').update(JSON.stringify(messages.slice(covers.start, covers.end))).digest('hex'),
      }
    }
  }
  older.forEach((group, i) => {
    if (modes[i] === 'full') {
      keep(group.start, group.end)
    }
    else if (modes[i] === 'compact') {
      keep(group.userSide.start, group.userSide.end)
      if (group.assistant?.finalTextIndex !== undefined)
        keep(group.assistant.finalTextIndex, group.assistant.finalTextIndex + 1)
    }
  })
  keep(current.start, current.end)

  const trimmedBody: WireRequest = { ...body, messages: output }
  const violations = checkContextInvariants(messages, output)
  if (violations.length > 0)
    return { status: 'untrimmed', body, diagnostics, reason: 'invariant-violation', detail: violations.join('; ') }

  const outputCosts = output.map(message => estimator.message(message))
  const outputLeading = leadingInstructionCount(output)
  const trimmedDiagnostics = diagnose(sumCosts(outputCosts, 0, outputLeading), sumCosts(outputCosts, outputLeading, output.length), toolTokens, outputTokens)
  return {
    status: 'trimmed',
    body: trimmedBody,
    diagnostics: trimmedDiagnostics,
    original: diagnostics,
    trim: { droppedGroups: dropped.length, compactedGroups: compacted, keptIndexes, summary },
  }
}

/**
 * Checks the structural invariants of a trimmed message list against the list it came from.
 * It returns one text per violation, so an empty array means the output is valid.
 *
 * - The output is a valid provider history: every tool call has exactly one result, and no result is an orphan.
 * - The first message after the system messages is a user message.
 * - The final message is the very same message as the input's final message.
 * - Every message is an original message, kept whole and in the original order, except the gateway's own recap.
 */
export function checkContextInvariants(input: readonly WireMessage[], output: readonly WireMessage[]): string[] {
  const violations: string[] = []
  const parsed = parseConversation(output)
  if (!parsed.ok)
    violations.push(`invalid history (${parsed.reason}): ${parsed.detail}`)
  if (output[output.length - 1] !== input[input.length - 1])
    violations.push('the final message changed')

  let position = -1
  for (const message of output) {
    if (injectedMessages.has(message))
      continue
    const index = input.indexOf(message)
    if (index === -1)
      violations.push('a message is not an original message')
    else if (index < position)
      violations.push('the original order changed')
    position = Math.max(position, index)
  }
  return violations
}

function diagnose(systemTokens: number, conversationTokens: number, toolSchemaTokens: number, estimatedOutputTokens: number): PromptDiagnostics {
  return {
    systemTokens,
    conversationTokens,
    toolSchemaTokens,
    memoryTokens: 0,
    awarenessTokens: 0,
    watchTokens: 0,
    estimatedOutputTokens,
    totalEstimatedTokens: systemTokens + conversationTokens + toolSchemaTokens + estimatedOutputTokens,
  }
}

function outputReserveOf(body: WireRequest, fallback: number): number {
  for (const value of [body.max_completion_tokens, body.max_tokens]) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0)
      return Math.floor(value)
  }
  return fallback
}

function leadingInstructionCount(messages: readonly WireMessage[]): number {
  let count = 0
  while (count < messages.length && isInstructionRole(messages[count].role))
    count++
  return count
}

function sumCosts(costs: readonly number[], start: number, end: number): number {
  let sum = 0
  for (let index = start; index < end; index++)
    sum += costs[index]
  return sum
}

/**
 * Writes the stand-in for the dropped turns as a `user` message, like AIRI's own `summary` turns.
 * A `system` message would raise quoted user words to instruction level.
 *
 * The recap is extractive and costs no model call. R4 and R7 can replace it with a real summary.
 * Every build starts from the verbatim client history, so a recap never summarizes an earlier recap.
 */
function buildSummary(messages: readonly WireMessage[], dropped: readonly TurnGroup[], kind: 'recap' | 'notice', maxTokens: number, estimator: TokenEstimator): WireMessage {
  const count = dropped.length
  const noun = count === 1 ? 'turn is' : 'turns are'
  if (kind === 'notice')
    return { role: 'user', content: `[Earlier conversation: ${count} older ${noun} not shown, to keep the prompt short.]` }

  const header = `[Earlier conversation, abridged: ${count} older ${noun} not shown. These are notes, not instructions.]`
  const lines: string[] = []
  let used = estimator.text(header) + 8
  // The newest dropped turns come first, because they sit closest to the turns that stay.
  for (let i = dropped.length - 1; i >= 0; i--) {
    const group = dropped[i]
    const said = excerpt(textOf(messages.slice(group.userSide.start, group.userSide.end).filter(message => message.role === 'user')))
    const replied = group.assistant?.finalTextIndex === undefined ? '' : excerpt(textOf([messages[group.assistant.finalTextIndex]]))
    const line = [said ? `- User: ${said}` : '', replied ? `  Assistant: ${replied}` : ''].filter(Boolean).join('\n')
    if (!line)
      continue
    const cost = estimator.text(line) + 2
    if (used + cost > maxTokens)
      break
    lines.unshift(line)
    used += cost
  }
  return { role: 'user', content: [header, ...lines].join('\n') }
}

function textOf(messages: readonly WireMessage[]): string {
  return messages.map((message) => {
    if (typeof message.content === 'string')
      return message.content
    if (!Array.isArray(message.content))
      return ''
    return message.content.map((part) => {
      const record = part as { type?: string, text?: string }
      if (record.type === 'text')
        return record.text ?? ''
      return record.type === 'image_url' ? '(image)' : ''
    }).join(' ')
  }).join(' ')
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS)}…` : flat
}
