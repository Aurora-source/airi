import type { MemoryObservation } from '../src/memory/ports'

import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SQLiteMemoryStore } from '../src/memory/sqlite-store'

describe('r4 memory replay', () => {
  let folder: string
  let store: SQLiteMemoryStore
  let now: number
  const day = 86_400_000

  function observation(overrides: Partial<MemoryObservation> = {}): MemoryObservation {
    return {
      userId: 'user',
      characterId: 'mura',
      source: 'airi',
      kind: 'user_text',
      text: 'My name is Rikon.',
      occurredAt: now,
      sessionId: 'session',
      messageId: 'message',
      claims: [{ key: 'user.name', value: 'Rikon', text: 'The user is named Rikon.', category: 'identity', attribution: 'user_said', scope: 'global', aboutUser: true }],
      ...overrides,
    }
  }

  beforeEach(() => {
    now = Date.UTC(2026, 9, 7, 10)
    folder = mkdtempSync(join(tmpdir(), 'airi-r4-'))
    store = new SQLiteMemoryStore(join(folder, 'memory.db'), () => now)
  })

  afterEach(() => {
    store.close()
    rmSync(folder, { recursive: true, force: true })
  })

  it('promotes one gateway event to AIRI authority and deduplicates retries', () => {
    const first = store.ingest(observation({ source: 'gateway', requestId: 'request' }))
    expect(store.inspect({ userId: 'user', characterId: 'mura' })).toHaveLength(0)
    expect(store.ingest(observation({ source: 'gateway', requestId: 'request' })).status).toBe('duplicate')
    const authoritative = store.ingest(observation())
    expect(authoritative.status).toBe('promoted')
    expect(authoritative.eventId).toBe(first.eventId)
    expect(store.ingest(observation()).status).toBe('duplicate')
    const data = store.exportUser('user')
    expect(data.tables.events).toHaveLength(1)
    expect(data.tables.events[0].canonical_id).toBe('airi:session:msg:message')
    expect(store.inspect({ userId: 'user', characterId: 'mura', kind: 'fact' })).toHaveLength(1)
  })

  it('handles authoritative-first arrival without merging two distinct persisted turns', () => {
    store.ingest(observation())
    expect(store.ingest(observation({ source: 'gateway', requestId: 'request' })).status).toBe('duplicate')
    store.ingest(observation({ messageId: 'second' }))
    expect(store.exportUser('user').tables.events).toHaveLength(2)
  })

  it('rejects a reused request ID that refers to another authoritative turn', () => {
    store.ingest(observation({ requestId: 'request' }))
    expect(store.ingest(observation({ requestId: 'request', messageId: 'different' })).status).toBe('invalid')
    expect(store.exportUser('user').tables.events).toHaveLength(1)
  })

  it('never admits interrupted responses or corrupt events', () => {
    expect(store.ingest(observation({ source: 'gateway', requestId: 'request', completion: 'incomplete' })).status).toBe('ignored')
    expect(store.ingest(observation({ characterId: '' })).status).toBe('invalid')
    expect(store.ingest(observation({ occurredAt: Number.NaN })).status).toBe('invalid')
    expect(store.ingest(observation({ messageId: undefined })).status).toBe('invalid')
    expect(store.exportUser('user').tables.events).toHaveLength(0)
  })

  it('attaches tool results by call ID and keys Spark reactions by notification ID', () => {
    const reply = observation({ kind: 'assistant', turnId: 'turn', claims: [], tools: [{ callId: 'call', name: 'search', outcome: 'success', text: 'Found a result' }] })
    store.ingest(reply)
    store.ingest(reply)
    const spark = observation({ source: 'spark', kind: 'spark_reaction', sparkId: 'notify', claims: [] })
    store.ingest(spark)
    store.ingest(spark)
    expect(store.exportUser('user').tables.events).toHaveLength(2)
    expect(store.exportUser('user').tables.tool_evidence).toHaveLength(1)
  })

  it('keys watch milestones by watch event ID, opens a watch-session episode, and refuses claims from them', () => {
    const start = observation({ source: 'watch', kind: 'watch_milestone', watchEventId: 'watch-1:1', messageId: undefined, boundary: 'watch_start', text: 'Started watching "Frieren" on youtube.', claims: [] })
    expect(store.ingest(start).status).toBe('inserted')
    expect(store.ingest(start).status).toBe('duplicate')
    expect(store.ingest({ ...start, watchEventId: undefined }).status).toBe('invalid')
    expect(store.ingest({ ...start, watchEventId: 'watch-1:2', kind: 'user_text' }).status).toBe('invalid')
    expect(store.ingest({ ...start, watchEventId: 'watch-1:3', claims: observation().claims }).status).toBe('invalid')
    expect(store.ingest({ ...start, watchEventId: 'watch-1:4', relationship: { closeness: 1 } }).status).toBe('invalid')

    const data = store.exportUser('user')
    expect(data.tables.events.map(event => event.canonical_id)).toEqual(['watch:watch-1%3A1'])
    expect(store.inspect({ userId: 'user', characterId: 'mura', kind: 'episode' }).map(item => item.category)).toEqual(['watch_session'])
    expect(store.inspect({ userId: 'user', characterId: 'mura', kind: 'fact' })).toHaveLength(0)
  })

  it('discards provisional events with authority coverage and degrades only uncovered evidence', () => {
    store.setAuthorityAvailable('user', 'mura', true)
    store.ingest(observation({ source: 'gateway', requestId: 'covered' }))
    store.ingest(observation({ source: 'gateway', requestId: 'uncovered', characterId: 'other' }))
    now += 11 * 60_000
    const result = store.consolidate()
    expect(result.discarded).toBe(1)
    expect(result.degraded).toBe(1)
    expect(store.inspect({ userId: 'user', characterId: 'other', kind: 'fact' })[0].confidence).toBeLessThanOrEqual(0.5)
  })

  it('uses only authority coverage inside the ten-minute provisional window', () => {
    store.ingest(observation({ source: 'gateway', requestId: 'uncovered' }))
    now += 11 * 60_000
    store.setAuthorityAvailable('user', 'mura', true)
    expect(store.consolidate().degraded).toBe(1)
  })

  it('shares global self-facts but isolates episodes and character facts', () => {
    store.ingest(observation())
    store.ingest(observation({ messageId: 'nickname', text: 'Call me captain.', claims: [{ key: 'nickname', value: 'captain', text: 'Mura calls the user captain.', category: 'nickname', attribution: 'user_said' }] }))
    const other = store.inspect({ userId: 'user', characterId: 'other' })
    expect(other).toHaveLength(1)
    expect(other[0].scope).toBe('global')
    expect(store.recall({ userId: 'other-user', characterId: 'mura', query: 'Rikon' }).items).toHaveLength(0)
  })

  it('rejects unsafe promotion of a character nickname to global memory', () => {
    const input = observation({ claims: [{ key: 'nickname', value: 'captain', text: 'Mura calls me captain.', category: 'nickname', attribution: 'user_said', scope: 'global', aboutUser: true }] })
    expect(store.ingest(input).status).toBe('invalid')
    expect(store.exportUser('user').tables.events).toHaveLength(0)
  })

  it('corrects facts, preserves provenance and supports historical validity', () => {
    store.ingest(observation())
    now += day
    store.ingest(observation({ messageId: 'correction', text: 'Actually my name is Ren.', claims: [{ key: 'user.name', value: 'Ren', text: 'The user is named Ren.', category: 'identity', attribution: 'user_said', scope: 'global', aboutUser: true, correction: true }] }))
    const facts = store.inspect({ userId: 'user', characterId: 'mura', kind: 'fact' })
    expect(facts).toHaveLength(2)
    expect(facts.find(f => f.originalText.includes('Rikon'))?.state).toBe('superseded')
    expect(store.recall({ userId: 'user', characterId: 'mura', query: 'Rikon' }).items.filter(i => i.kind === 'fact')).toHaveLength(0)
    expect(store.recall({ userId: 'user', characterId: 'mura', query: 'Rikon', asOf: now - day }).items.some(i => i.kind === 'fact')).toBe(true)
    expect(facts.every(f => f.provenance.length === 1)).toBe(true)
  })

  it('quarantines contradictions instead of choosing an unproven truth', () => {
    store.ingest(observation())
    store.ingest(observation({ messageId: 'conflict', claims: [{ key: 'user.name', value: 'Ren', text: 'The user is named Ren.', category: 'identity', attribution: 'user_said', scope: 'global', aboutUser: true }] }))
    const facts = store.inspect({ userId: 'user', characterId: 'mura', kind: 'fact' })
    expect(facts.every(f => f.state === 'contested')).toBe(true)
    expect(store.recall({ userId: 'user', characterId: 'mura', query: 'user named' }).items.filter(i => i.kind === 'fact')).toHaveLength(0)
  })

  it('deduplicates differently phrased facts with the same semantic key and value', () => {
    store.ingest(observation())
    store.ingest(observation({ messageId: 'phrased', text: 'You can call me Rikon.', claims: [{ key: 'user.name', value: 'rikon', text: 'Rikon is the user name.', category: 'identity', attribution: 'user_said', scope: 'global', aboutUser: true }] }))
    const facts = store.inspect({ userId: 'user', characterId: 'mura', kind: 'fact' })
    expect(facts).toHaveLength(1)
    expect(facts[0].provenance).toHaveLength(2)
  })

  it('segments idle gaps, topic changes, tasks and watch boundaries', () => {
    store.ingest(observation({ claims: [], topic: 'coding' }))
    now += 60_000
    store.ingest(observation({ messageId: 'same', claims: [], topic: 'coding' }))
    expect(store.inspect({ userId: 'user', characterId: 'mura', kind: 'episode' })).toHaveLength(1)
    now += 21 * 60_000
    store.ingest(observation({ messageId: 'idle', claims: [], topic: 'coding' }))
    store.ingest(observation({ messageId: 'topic', claims: [], topic: 'music' }))
    store.ingest(observation({ messageId: 'task', claims: [], boundary: 'task' }))
    store.ingest(observation({ turnId: 'watch', kind: 'watch_milestone', claims: [], boundary: 'watch_start' }))
    expect(store.inspect({ userId: 'user', characterId: 'mura', kind: 'episode' })).toHaveLength(5)
    now += 11 * 60_000
    expect(store.consolidate().settled).toBeGreaterThan(0)
    expect(store.consolidate().consolidated).toBe(0)
  })

  it('bounds FTS recall, strips ACT and reasoning text, and avoids irrelevant injection', () => {
    store.ingest(observation({ text: '[10:30] <think>secret</think><|ACT:smile|> My name is Rikon.' }))
    const recall = store.recall({ userId: 'user', characterId: 'mura', query: 'Rikon', maxItems: 2, maxBytes: 550 })
    expect(recall.items.length).toBeGreaterThan(0)
    expect(recall.items.length).toBeLessThanOrEqual(2)
    expect(Buffer.byteLength(recall.prompt)).toBeLessThanOrEqual(550)
    expect(recall.prompt).not.toContain('secret')
    expect(recall.prompt).not.toContain('ACT:')
    expect(store.recall({ userId: 'user', characterId: 'mura', query: 'volcano spacecraft' }).prompt).toBe('')
    expect(store.recall({ userId: 'user', characterId: 'mura', query: '" OR * : NEAR(' }).items).toHaveLength(0)
  })

  it('reinforces only reviewed use once and lets episode retrievability decay', () => {
    store.ingest(observation({ claims: [] }))
    const initial = store.inspect({ userId: 'user', characterId: 'mura', kind: 'episode' })[0]
    now += 1000 * day
    const recall = store.recall({ userId: 'user', characterId: 'mura', query: 'Rikon' })
    expect(recall.items).toHaveLength(1)
    expect(store.inspect({ userId: 'user', characterId: 'mura', kind: 'episode' })[0].stability).toBe(initial.stability)
    store.acceptRecall('user', recall.recallId!, Date.now())
    expect(store.review('user', recall.recallId!, [initial.id])).toBe(true)
    expect(store.review('user', recall.recallId!, [initial.id])).toBe(false)
    expect(store.inspect({ userId: 'user', characterId: 'mura', kind: 'episode' })[0].stability).toBeGreaterThan(initial.stability)
  })

  it('caps relationship changes, deduplicates them and preserves character ownership', () => {
    const input = observation({ claims: [], relationship: { trust: 0.8 } })
    store.ingest(input)
    store.ingest(input)
    const data = store.exportUser('user')
    expect(data.tables.relationship[0].trust).toBe(0.05)
    expect(store.inspect({ userId: 'user', characterId: 'other' })).toHaveLength(0)
  })

  it('edits and deletes memory with source evidence and updates FTS immediately', () => {
    store.ingest(observation())
    const fact = store.inspect({ userId: 'user', characterId: 'mura', kind: 'fact' })[0]
    expect(store.edit({ userId: 'other', itemId: fact.id, text: 'stolen' })).toBeNull()
    expect(store.edit({ userId: 'user', itemId: fact.id, text: 'The user name is Ren.', value: 'Ren', pinned: true })?.pinned).toBe(true)
    expect(store.recall({ userId: 'user', characterId: 'other', query: 'Ren' }).items).toHaveLength(1)
    expect(store.delete({ userId: 'user', itemId: fact.id })).toBe(true)
    expect(store.recall({ userId: 'user', characterId: 'mura', query: 'Rikon Ren' }).items).toHaveLength(0)
  })

  it('forgets derived and source content and blocks replay across restart', () => {
    store.ingest(observation())
    const fact = store.inspect({ userId: 'user', characterId: 'mura', kind: 'fact' })[0]
    expect(store.forget({ userId: 'user', itemId: fact.id })).toBe(true)
    expect(store.recall({ userId: 'user', characterId: 'mura', query: 'Rikon' }).items).toHaveLength(0)
    const data = store.exportUser('user')
    expect(JSON.stringify(data)).not.toContain('Rikon')
    expect(data.tables.deletions.length).toBeGreaterThan(0)
    store.close()
    store = new SQLiteMemoryStore(join(folder, 'memory.db'), () => now)
    expect(store.ingest(observation()).status).toBe('forgotten')
    expect(store.ingest(observation({ messageId: 'reimport' })).status).toBe('forgotten')
  })

  it('blocks a forgotten semantic fact phrased differently in another character', () => {
    store.ingest(observation())
    const fact = store.inspect({ userId: 'user', characterId: 'mura', kind: 'fact' })[0]
    store.forget({ userId: 'user', itemId: fact.id })
    const rephrased = observation({ characterId: 'other', messageId: 'paraphrase', text: 'You can call me Rikon.' })
    expect(store.ingest(rephrased).status).toBe('forgotten')
    expect(store.recall({ userId: 'user', characterId: 'other', query: 'Rikon' }).items).toHaveLength(0)
  })

  it('persists private mode, backs up a consistent database and survives restart', () => {
    store.ingest(observation())
    store.backup(join(folder, 'backup.db'))
    const restored = new SQLiteMemoryStore(join(folder, 'backup.db'), () => now)
    expect(restored.recall({ userId: 'user', characterId: 'other', query: 'Rikon' }).items).toHaveLength(1)
    restored.close()
    store.setPrivateMode('user', true)
    expect(store.ingest(observation({ messageId: 'private' })).status).toBe('private')
    store.close()
    store = new SQLiteMemoryStore(join(folder, 'memory.db'), () => now)
    expect(store.ingest(observation({ messageId: 'private' })).status).toBe('private')
    expect(store.exportUser('user').schemaVersion).toBe(2)
  })

  it('suspends queued consolidation, recall tracking and reinforcement in private mode', () => {
    store.ingest(observation({ source: 'gateway', requestId: 'pending', characterId: 'pending-character' }))
    store.ingest(observation({ messageId: 'persisted', text: 'We enjoy astronomy.', claims: [] }))
    const recalled = store.recall({ userId: 'user', characterId: 'mura', query: 'astronomy' })
    store.acceptRecall('user', recalled.recallId!, Date.now())
    store.setPrivateMode('user', true)
    now += 11 * 60_000
    const consolidated = store.consolidate()
    expect(consolidated.degraded).toBe(0)
    expect(consolidated.consolidated).toBe(0)
    expect(store.review('user', recalled.recallId!, recalled.items.map(item => item.id))).toBe(false)
    expect(store.recall({ userId: 'user', characterId: 'mura', query: 'astronomy' }).recallId).toBeUndefined()
    expect(store.inspect({ userId: 'user', characterId: 'mura', kind: 'fact' })).toHaveLength(0)
  })

  it('keeps nonoverlapping historical validity intervals free of contradictions', () => {
    const later = observation({ messageId: 'later', claims: [{ key: 'user.name', value: 'Ren', text: 'The user was named Ren.', category: 'identity', attribution: 'user_said', scope: 'global', aboutUser: true, validFrom: now + day, validTo: now + 2 * day }] })
    const earlier = observation({ messageId: 'earlier', claims: [{ key: 'user.name', value: 'Rikon', text: 'The user was named Rikon.', category: 'identity', attribution: 'user_said', scope: 'global', aboutUser: true, validFrom: now, validTo: now + day }] })
    store.ingest(later)
    store.ingest(earlier)
    expect(store.inspect({ userId: 'user', characterId: 'mura', kind: 'fact' }).every(item => item.state === 'active')).toBe(true)
    expect(store.recall({ userId: 'user', characterId: 'other', query: 'Rikon', asOf: now }).items).toHaveLength(1)
    expect(store.recall({ userId: 'user', characterId: 'other', query: 'Ren', asOf: now + day }).items).toHaveLength(1)
  })

  it('forgets global semantics in every character and blocks default-scope re-import', () => {
    store.ingest(observation())
    store.ingest(observation({ characterId: 'other', messageId: 'character-copy', claims: [{ key: 'user.name', value: 'Rikon', text: 'The user name is Rikon.', category: 'identity', attribution: 'user_said' }] }))
    const global = store.inspect({ userId: 'user', characterId: 'mura', kind: 'fact' })[0]
    store.forget({ userId: 'user', itemId: global.id })
    expect(store.recall({ userId: 'user', characterId: 'other', query: 'Rikon' }).items).toHaveLength(0)
    const replay = observation({ characterId: 'third', messageId: 'default-scope', text: 'I go by Rikon.', claims: [{ key: 'user.name', value: 'Rikon', text: 'Rikon is the user name.', category: 'identity', attribution: 'user_said' }] })
    expect(store.ingest(replay).status).toBe('forgotten')
    expect(JSON.stringify(store.exportUser('user'))).not.toContain('Rikon')
  })

  it('keeps speculative text correlation reversible for repeated assistant text', () => {
    const first = observation({ kind: 'assistant', turnId: 'first', text: 'Sure!', claims: [] })
    store.ingest(first)
    now += 1000
    store.ingest({ ...first, source: 'gateway', requestId: 'new-request', occurredAt: now })
    expect(store.ingest({ ...first, turnId: 'second', requestId: 'new-request', occurredAt: now }).status).toBe('inserted')
    expect(store.exportUser('user').tables.events).toHaveLength(2)
  })

  it('requires a persisted user message ID even when a turn ID is available', () => {
    expect(store.ingest(observation({ messageId: undefined, turnId: 'turn' })).status).toBe('invalid')
    expect(store.ingest(observation({ kind: 'assistant', turnId: 'turn', text: 'Hello Rikon.', claims: [] })).status).toBe('inserted')
  })

  it('does not move strong request ownership when a duplicate canonical event adds metadata', () => {
    const first = observation({ kind: 'assistant', turnId: 'first', requestId: 'request', claims: [], text: 'Sure!' })
    store.ingest(first)
    store.ingest({ ...first, turnId: 'second', requestId: undefined })
    expect(store.ingest({ ...first, turnId: 'second' }).status).toBe('invalid')
    expect(store.exportUser('user').tables.request_receipts[0].event_id).toBe(store.exportUser('user').tables.events.find(event => event.canonical_id === 'airi:session:turn:first')?.id)
  })

  it('preserves older corroboration and filters superseded episodes at the requested time', () => {
    store.ingest(observation())
    store.ingest(observation({ messageId: 'older', occurredAt: now - day }))
    expect(store.recall({ userId: 'user', characterId: 'other', query: 'Rikon', asOf: now - day }).items).toHaveLength(1)
    now += day
    store.ingest(observation({ messageId: 'corrected', text: 'My name is Ren.', claims: [{ key: 'user.name', value: 'Ren', text: 'The user name is Ren.', category: 'identity', attribution: 'user_said', scope: 'global', aboutUser: true, correction: true }] }))
    expect(store.recall({ userId: 'user', characterId: 'mura', query: 'Rikon', asOf: now }).items).toHaveLength(0)
  })

  it('resolves a contested fact through an explicit admin edit', () => {
    store.ingest(observation())
    store.ingest(observation({ messageId: 'conflict', text: 'My name is Ren.', claims: [{ key: 'user.name', value: 'Ren', text: 'The user name is Ren.', category: 'identity', attribution: 'user_said', scope: 'global', aboutUser: true }] }))
    const selected = store.inspect({ userId: 'user', characterId: 'mura', kind: 'fact' }).find(item => item.originalText.includes('Ren'))!
    expect(store.edit({ userId: 'user', itemId: selected.id, resolveConflict: true })?.state).toBe('active')
    expect(store.recall({ userId: 'user', characterId: 'other', query: 'Ren' }).items).toHaveLength(1)
  })

  it('never recalls rejected historical alternatives after explicit admin resolution', () => {
    const plantedAt = now
    store.ingest(observation())
    store.ingest(observation({ messageId: 'conflict', text: 'My name is Ren.', claims: [{ key: 'user.name', value: 'Ren', text: 'The user name is Ren.', category: 'identity', attribution: 'user_said', scope: 'global', aboutUser: true }] }))
    const selected = store.inspect({ userId: 'user', characterId: 'mura', kind: 'fact' }).find(item => item.originalText.includes('Ren'))!
    now += day
    store.edit({ userId: 'user', itemId: selected.id, resolveConflict: true })
    const historical = store.recall({ userId: 'user', characterId: 'other', query: 'user name', asOf: plantedAt })
    expect(historical.items).toHaveLength(1)
    expect(historical.items[0].originalText).toContain('Ren')
    expect(store.recall({ userId: 'user', characterId: 'mura', query: 'Rikon', asOf: plantedAt }).items).toHaveLength(0)
  })

  it('uses category cues for promises and excludes conversational filler from relevance', () => {
    store.ingest(observation({ text: 'You can call me Rikon.' }))
    expect(store.recall({ userId: 'user', characterId: 'mura', query: 'Can you tell me about volcanic eruptions?' }).items).toHaveLength(0)
    store.ingest(observation({ messageId: 'promise', text: 'I will finish the astronomy report.', claims: [{ key: 'report', value: 'finish', text: 'We will finish the astronomy report.', category: 'promise', attribution: 'user_said' }] }))
    expect(store.recall({ userId: 'user', characterId: 'mura', query: 'open promises' }).items.some(item => item.category === 'promise')).toBe(true)
  })

  it('preserves full episode time ranges after bounding the stored summary', () => {
    const startedAt = now
    for (let index = 0; index < 24; index++) {
      store.ingest(observation({ messageId: `message-${index}`, claims: [], text: `Astronomy ${index}.` }))
      now += 1000
    }
    const data = store.exportUser('user')
    expect(data.tables.episodes).toHaveLength(1)
    expect(data.tables.episodes[0].started_at).toBe(startedAt)
    expect(data.tables.episode_events).toHaveLength(24)
  })

  it('ranks a reinforced episode above an equally old unreviewed episode after decay', () => {
    store.ingest(observation({ messageId: 'first', claims: [], text: 'We discussed comet astronomy.', boundary: 'task' }))
    store.ingest(observation({ messageId: 'second', claims: [], text: 'We discussed comet astronomy.', boundary: 'task' }))
    const episode = store.inspect({ userId: 'user', characterId: 'mura', kind: 'episode' })[0]
    store.edit({ userId: 'user', itemId: episode.id, pinned: true })
    const recalled = store.recall({ userId: 'user', characterId: 'mura', query: 'comet astronomy', maxItems: 1 })
    expect(recalled.items[0].id).toBe(episode.id)
    store.acceptRecall('user', recalled.recallId!, Date.now())
    now += 10 * day
    store.review('user', recalled.recallId!, [episode.id])
    store.edit({ userId: 'user', itemId: episode.id, pinned: false })
    now += 1000 * day
    expect(store.recall({ userId: 'user', characterId: 'mura', query: 'comet astronomy', maxItems: 1 }).items[0].id).toBe(episode.id)
    expect(store.inspect({ userId: 'user', characterId: 'mura', kind: 'episode' }).find(item => item.id !== episode.id)?.repetitions).toBe(0)
  })
})
