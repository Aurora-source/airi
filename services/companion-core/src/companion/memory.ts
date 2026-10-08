import type { InjectedUnit } from '../budget/budgeter'
import type { WireRequest } from '../budget/wire'
import type { TurnOutcome } from '../gateway/turn-hooks'
import type { Category, ConsolidationResult, IngestResult, MemoryAdminPort, MemoryConsolidationPort, MemoryEventPort, MemoryItem, MemoryObservation, MemoryQueryPort, ToolEvidence } from '../memory/ports'
import type { TurnIdentity } from './turn-identity'

import { errorMessageFrom } from '@moeru/std'

import { fingerprint, normalizeText, visibleText } from '../memory/identity'
import { currentToolEvidence, currentUserText, isToolContinuation } from './wire-text'

export type MemoryPorts = MemoryEventPort & MemoryQueryPort & MemoryAdminPort & MemoryConsolidationPort

export interface CompanionMemoryOptions {
  userId: string
  recallDeadlineMs: number
  maxItems: number
  maxBytes: number
  now?: () => number
  /** Receives one line per failure. It holds ids and reasons, never memory text. */
  report?: (message: string) => void
}

/** A persisted AIRI turn, as the server channel reports it after storage succeeded. */
export interface PersistedTurn {
  sessionId: string
  characterId: string
  /** Id of the committed user message. It is also the round id. */
  userMessageId: string
  userText: string
  /** `AssistantTurn.id` of the generation transcript, or the persisted assistant message id. */
  assistantTurnId: string
  assistantText: string
  occurredAt: number
  tools?: ToolEvidence[]
  /** Set when a Spark notification opened the turn. */
  sparkId?: string
}

export interface RememberRequest {
  text: string
  key: string
  value: string
  category: Category
  scope: 'global' | 'character'
  correction?: boolean
  cardinality?: 'single' | 'set'
}

/** A watch milestone as the watch runtime offers it. It holds identity text, never captions or frames. */
export interface WatchMilestone {
  /** Unique per watch session and event. A replay with the same id changes nothing. */
  id: string
  boundary?: 'watch_start' | 'watch_stop'
  text: string
  occurredAt: number
}

/** A recalled item as tools and Ops see it. It holds no provenance internals. */
export interface RecalledItem {
  id: string
  kind: MemoryItem['kind']
  scope: MemoryItem['scope']
  category: string
  text: string
  occurredAt: string
  state: MemoryItem['state']
}

interface RoundContext {
  unit?: InjectedUnit
  recallId?: string
  items: { id: string, text: string }[]
  reviewed: boolean
  userObserved: boolean
  expiresAt: number
}

const ROUND_TTL_MS = 10 * 60_000
/** Slack above the recall deadline before the adapter stops waiting for a port that does not answer. */
const RECALL_GUARD_MS = 100
const MAX_ROUNDS = 128
const MAX_SHOWN_PER_CHARACTER = 256
/** An active turn older than this cannot bind tool calls. */
const ACTIVE_TURN_TTL_MS = 30 * 60_000
const STOP_WORDS = new Set('about after again also always been before being both could does doing done from have just like make many more most much must only other over said same some such than that their them then there these they thing this those through very want were what when where which while with would your user_text assistant memory_command'.split(' '))

/**
 * Connects the R4 memory ports to the gateway, the AIRI server channel, the tools, and Ops.
 *
 * - Recall runs once per AIRI round before routing. Later tool rounds of the same round reuse its block.
 * - The gateway observes a delivered answer as provisional evidence. The channel observes the persisted turn as
 *   authoritative evidence. R4 merges both into one event.
 * - Tools act for the one local user and the character of the newest AIRI turn. They never take a user id.
 *
 * Call stack:
 *
 * CompanionRuntime.begin (./runtime)
 *   -> {@link CompanionMemory.begin}
 *     -> MemoryQueryPort.recall
 *   -> finish -> MemoryEventPort.ingest (gateway, provisional) / MemoryConsolidationPort.review
 * ChannelObserver (./channel-observer)
 *   -> {@link CompanionMemory.observePersistedTurn} -> MemoryEventPort.ingest (airi, authoritative)
 */
export class CompanionMemory {
  private readonly rounds = new Map<string, RoundContext>()
  private readonly shown = new Map<string, Set<string>>()
  private readonly authorityCharacters = new Set<string>()
  private readonly now: () => number
  private readonly report: (message: string) => void
  private active?: { identity: TurnIdentity, at: number }
  private channelConnected = false
  private inflight = 0
  private lastTurnAt = 0
  private consolidating?: Promise<ConsolidationResult | undefined>
  private timer?: ReturnType<typeof setInterval>
  private batch = 20
  private lastConsolidation?: { at: string, durationMs: number, result?: ConsolidationResult, error?: string }

  constructor(readonly ports: MemoryPorts, readonly options: CompanionMemoryOptions) {
    this.now = options.now ?? Date.now
    this.report = options.report ?? (() => {})
  }

  get userId(): string {
    return this.options.userId
  }

  /** The character and session of the newest AIRI turn, while it is recent. */
  activeTurn(): TurnIdentity | undefined {
    if (!this.active || this.now() - this.active.at > ACTIVE_TURN_TTL_MS)
      return undefined
    return this.active.identity
  }

  /**
   * Prepares memory for one chat request. It never throws. A recall miss or timeout returns no unit.
   * The returned `finish` observes the answer and reviews the recalled items that the answer used.
   */
  async begin(identity: TurnIdentity, body: WireRequest): Promise<{ unit?: InjectedUnit, finish: (outcome: TurnOutcome) => void }> {
    this.inflight++
    this.lastTurnAt = this.now()
    this.active = { identity, at: this.now() }
    this.markAuthority(identity.characterId)
    const round = await this.roundContext(identity, body)
    let finished = false
    return {
      unit: round.unit,
      finish: (outcome) => {
        if (finished)
          return
        finished = true
        this.inflight--
        this.lastTurnAt = this.now()
        if (outcome.status === 'complete')
          void this.afterDelivery(identity, body, round, outcome.reply)
      },
    }
  }

  private async roundContext(identity: TurnIdentity, body: WireRequest): Promise<RoundContext> {
    const key = `${identity.characterId}|${identity.sessionId}|${identity.roundId}`
    const now = this.now()
    const cached = this.rounds.get(key)
    if (cached && cached.expiresAt > now)
      return cached
    for (const [id, round] of this.rounds) {
      if (round.expiresAt <= now || this.rounds.size >= MAX_ROUNDS)
        this.rounds.delete(id)
    }
    const round: RoundContext = { items: [], reviewed: false, userObserved: false, expiresAt: now + ROUND_TTL_MS }
    const query = currentUserText(body)
    if (query.trim()) {
      const result = await this.recallWithin({
        userId: this.options.userId,
        characterId: identity.characterId,
        query,
        maxItems: this.options.maxItems,
        maxBytes: this.options.maxBytes,
        deadlineMs: this.options.recallDeadlineMs,
      })
      if (result && result.prompt && result.items.length > 0) {
        round.unit = { kind: 'memory', message: { role: 'user', content: result.prompt } }
        round.recallId = result.recallId
        round.items = result.items.map(item => ({ id: item.id, text: item.originalText }))
        this.remember(identity.characterId, result.items.map(item => item.id))
      }
    }
    this.rounds.set(key, round)
    return round
  }

  /**
   * Recall with a local guard on top of the port's own deadline. A port that hangs or fails gives no memory,
   * and the turn still finishes, so idle consolidation is never blocked.
   */
  private async recallWithin(request: Parameters<MemoryPorts['recall']>[0]): Promise<Awaited<ReturnType<MemoryPorts['recall']>> | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const guard = new Promise<undefined>((resolve) => {
      timer = setTimeout(resolve, (request.deadlineMs ?? 150) + RECALL_GUARD_MS, undefined)
    })
    try {
      return await Promise.race([this.ports.recall(request).catch(() => undefined), guard])
    }
    finally {
      clearTimeout(timer)
    }
  }

  private async afterDelivery(identity: TurnIdentity, body: WireRequest, round: RoundContext, reply: { text: string, toolCalls: unknown[] }): Promise<void> {
    const occurredAt = this.now()
    const base = { userId: this.options.userId, characterId: identity.characterId, source: 'gateway' as const, sessionId: identity.sessionId, requestId: `round:${identity.roundId}`, occurredAt, completion: 'complete' as const }
    const observations: MemoryObservation[] = []
    if (!round.userObserved && !isToolContinuation(body)) {
      const text = currentUserText(body)
      if (text.trim()) {
        round.userObserved = true
        observations.push({ ...base, kind: 'user_text', text })
      }
    }
    // A round that asks for tools is not the answer yet. Only the final text of the turn is observed.
    const final = reply.toolCalls.length === 0 && reply.text.trim() !== ''
    if (final) {
      const tools = currentToolEvidence(body)
      observations.push({ ...base, kind: 'assistant', text: reply.text, ...(tools.length > 0 ? { tools } : {}) })
      if (round.recallId && !round.reviewed) {
        round.reviewed = true
        await this.ports.review(this.options.userId, round.recallId, usedItemIds(round.items, reply.text)).catch(error => this.report(`memory review failed: ${errorMessageFrom(error) ?? 'unknown'}`))
      }
    }
    for (const observation of observations)
      await this.ingest(observation)
  }

  /** Admits one persisted AIRI turn as authoritative evidence. Repeated channel events are idempotent. */
  async observePersistedTurn(turn: PersistedTurn): Promise<IngestResult[]> {
    this.markAuthority(turn.characterId)
    const base = { userId: this.options.userId, characterId: turn.characterId, sessionId: turn.sessionId, occurredAt: turn.occurredAt, completion: 'complete' as const }
    const results: IngestResult[] = []
    if (turn.userText.trim() && !turn.sparkId)
      results.push(await this.ingest({ ...base, source: 'airi', kind: 'user_text', messageId: turn.userMessageId, text: turn.userText }))
    if (turn.assistantText.trim()) {
      const tools = turn.tools?.length ? { tools: turn.tools.slice(0, 32) } : {}
      results.push(await this.ingest(turn.sparkId
        ? { ...base, source: 'spark', kind: 'spark_reaction', sparkId: turn.sparkId, text: turn.assistantText, ...tools }
        : { ...base, source: 'airi', kind: 'assistant', turnId: turn.assistantTurnId, text: turn.assistantText, ...tools }))
    }
    return results
  }

  /**
   * Offers one watch milestone to R4 for the character and AIRI session of the newest turn.
   * R4 decides what stays: a start opens a watch-session episode and a stop settles it.
   * Without an active turn no character owns the moment, so nothing is offered.
   */
  async observeWatchMilestone(milestone: WatchMilestone): Promise<IngestResult | { status: 'no-active-character' }> {
    const active = this.activeTurn()
    if (!active)
      return { status: 'no-active-character' }
    return this.ingest({
      userId: this.options.userId,
      characterId: active.characterId,
      source: 'watch',
      kind: 'watch_milestone',
      watchEventId: milestone.id,
      sessionId: active.sessionId,
      text: milestone.text,
      occurredAt: milestone.occurredAt,
      ...(milestone.boundary ? { boundary: milestone.boundary } : {}),
    })
  }

  /** The AIRI channel is the authoritative observer. Its coverage decides what happens to unmatched gateway evidence. */
  setChannelConnected(connected: boolean): void {
    if (this.channelConnected === connected)
      return
    this.channelConnected = connected
    if (connected) {
      const active = this.activeTurn()
      if (active)
        this.markAuthority(active.characterId)
      return
    }
    for (const characterId of this.authorityCharacters)
      void this.ports.setAuthorityAvailable(this.options.userId, characterId, false).catch(error => this.report(`memory authority update failed: ${errorMessageFrom(error) ?? 'unknown'}`))
    this.authorityCharacters.clear()
  }

  private markAuthority(characterId: string): void {
    if (!this.channelConnected || this.authorityCharacters.has(characterId))
      return
    this.authorityCharacters.add(characterId)
    void this.ports.setAuthorityAvailable(this.options.userId, characterId, true).catch(error => this.report(`memory authority update failed: ${errorMessageFrom(error) ?? 'unknown'}`))
  }

  private async ingest(observation: MemoryObservation): Promise<IngestResult> {
    try {
      const result = await this.ports.ingest(observation)
      if (result.status === 'invalid')
        this.report(`memory ingest rejected: ${observation.source}/${observation.kind} ${result.reason ?? ''}`)
      return result
    }
    catch (error) {
      this.report(`memory ingest failed: ${observation.source}/${observation.kind} ${errorMessageFrom(error) ?? 'unknown'}`)
      return { status: 'invalid', reason: 'ingest failed' }
    }
  }

  private remember(characterId: string, itemIds: string[]): void {
    let set = this.shown.get(characterId)
    if (!set) {
      set = new Set()
      this.shown.set(characterId, set)
    }
    for (const id of itemIds) {
      set.delete(id)
      set.add(id)
    }
    while (set.size > MAX_SHOWN_PER_CHARACTER)
      set.delete(set.values().next().value!)
  }

  /** Tool recall for the active character. It returns structured items, never the raw database. */
  async recallForTool(query: string): Promise<{ items: RecalledItem[], timedOut: boolean } | { error: 'no-active-character' }> {
    const active = this.activeTurn()
    if (!active)
      return { error: 'no-active-character' }
    const result = await this.recallWithin({ userId: this.options.userId, characterId: active.characterId, query, maxItems: this.options.maxItems, maxBytes: this.options.maxBytes, deadlineMs: Math.max(this.options.recallDeadlineMs, 500) })
    if (!result)
      return { items: [], timedOut: true }
    this.remember(active.characterId, result.items.map(item => item.id))
    return { items: result.items.map(recalledItem), timedOut: result.timedOut }
  }

  /**
   * Stores an explicit claim from a memory tool for the active character.
   * The request id covers the round, so a repeated tool call in one round changes nothing.
   */
  async rememberForTool(request: RememberRequest): Promise<IngestResult | { status: 'no-active-character' }> {
    const active = this.activeTurn()
    if (!active)
      return { status: 'no-active-character' }
    const requestId = `tool:${fingerprint(this.options.userId, active.characterId, active.roundId, request.scope, normalizeText(request.key), normalizeText(request.value), String(request.correction ?? false))}`
    return this.ingest({
      userId: this.options.userId,
      characterId: active.characterId,
      source: 'admin',
      kind: 'memory_command',
      requestId,
      // The session keeps the command in the conversation's episode. A later correction then hides that episode too.
      sessionId: active.sessionId,
      text: request.text,
      occurredAt: this.now(),
      claims: [{
        key: request.key,
        value: request.value,
        text: request.text,
        category: request.category,
        attribution: 'user_said',
        scope: request.scope,
        aboutUser: request.scope === 'global',
        correction: request.correction,
        cardinality: request.cardinality,
      }],
    })
  }

  /** Forgets one item that recall showed for the active character. Other ids are refused. */
  async forgetForTool(itemId: string): Promise<{ status: 'forgotten' | 'not-found' | 'not-shown' | 'no-active-character' }> {
    const active = this.activeTurn()
    if (!active)
      return { status: 'no-active-character' }
    if (!this.shown.get(active.characterId)?.has(itemId))
      return { status: 'not-shown' }
    const forgotten = await this.ports.forget({ userId: this.options.userId, itemId })
    this.shown.get(active.characterId)?.delete(itemId)
    return { status: forgotten ? 'forgotten' : 'not-found' }
  }

  /** Runs one bounded consolidation pass now. Concurrent calls share the pass. */
  consolidateNow(): Promise<ConsolidationResult | undefined> {
    this.consolidating ??= (async () => {
      const started = performance.now()
      try {
        const result = await this.ports.consolidate(this.batch)
        this.lastConsolidation = { at: new Date(this.now()).toISOString(), durationMs: Math.round(performance.now() - started), result }
        return result
      }
      catch (error) {
        this.lastConsolidation = { at: new Date(this.now()).toISOString(), durationMs: Math.round(performance.now() - started), error: errorMessageFrom(error) ?? 'consolidation failed' }
        return undefined
      }
      finally {
        this.consolidating = undefined
      }
    })()
    return this.consolidating
  }

  /**
   * Schedules idle consolidation. A pass runs only when no chat request is open and the last one ended at least
   * `idleMs` ago, so it never competes with a turn for the memory worker.
   */
  startConsolidation(intervalMs: number, batch: number, idleMs = 30_000): void {
    this.batch = batch
    if (this.timer)
      return
    this.timer = setInterval(() => {
      if (this.inflight === 0 && this.now() - this.lastTurnAt >= idleMs)
        void this.consolidateNow()
    }, intervalMs)
    this.timer.unref?.()
  }

  stopConsolidation(): void {
    if (this.timer)
      clearInterval(this.timer)
    this.timer = undefined
  }

  status() {
    const active = this.activeTurn()
    return {
      userId: this.options.userId,
      channelConnected: this.channelConnected,
      activeCharacterId: active?.characterId,
      inflightTurns: this.inflight,
      cachedRounds: this.rounds.size,
      lastConsolidation: this.lastConsolidation,
    }
  }
}

/** Tool results stay small, so each item text is capped. Ops reads full items through inspection. */
export function recalledItem(item: MemoryItem): RecalledItem {
  return { id: item.id, kind: item.kind, scope: item.scope, category: item.category, text: visibleText(item.originalText).slice(0, 300), occurredAt: new Date(item.occurredAt).toISOString(), state: item.state }
}

/**
 * Recalled items that the answer used. An item counts when the answer repeats at least two of its distinctive words,
 * or all of them when it has fewer. Injection alone never counts as use.
 *
 * @example
 * usedItemIds([{ id: 'a', text: 'favorite game Hollow Knight' }], 'You still love Hollow Knight!')
 * // => ['a']
 */
export function usedItemIds(items: readonly { id: string, text: string }[], reply: string): string[] {
  const replyWords = new Set(wordsOf(reply))
  return items.filter((item) => {
    const words = [...new Set(wordsOf(item.text))]
    const hits = words.filter(word => replyWords.has(word)).length
    return words.length > 0 && hits >= Math.min(2, words.length)
  }).map(item => item.id)
}

function wordsOf(text: string): string[] {
  return normalizeText(text).match(/[\p{L}\p{N}]{4,}/gu)?.filter(word => !STOP_WORDS.has(word)) ?? []
}
