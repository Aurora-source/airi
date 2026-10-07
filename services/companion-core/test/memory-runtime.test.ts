import type { MemoryObservation } from '../src/memory/ports'

import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MemoryClient } from '../src/memory'
import { canonicalIdentity, normalizeText } from '../src/memory/identity'
import { migrations } from '../src/memory/migrations'
import { SQLiteMemoryStore } from '../src/memory/sqlite-store'

describe('r4 worker, migrations and concurrency', () => {
  let folder: string
  const clients: MemoryClient[] = []

  function observation(index: number): MemoryObservation {
    return { userId: 'user', characterId: 'mura', source: 'airi', kind: 'user_text', text: `We discussed astronomy and telescope ${index}.`, occurredAt: Date.now(), sessionId: 'session', messageId: `message-${index}`, claims: [] }
  }

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'airi-r4-runtime-'))
  })

  afterEach(async () => {
    await Promise.all(clients.splice(0).map(client => client.close()))
    rmSync(folder, { recursive: true, force: true })
  })

  function client(): MemoryClient {
    const instance = new MemoryClient(join(folder, 'memory.db'))
    clients.push(instance)
    return instance
  }

  it('loads the real worker and persists memory across worker restart', async () => {
    const first = client()
    await first.ready()
    expect((await first.ingest(observation(1))).status).toBe('inserted')
    await first.close()
    const second = client()
    await second.ready()
    const recall = await second.recall({ userId: 'user', characterId: 'mura', query: 'astronomy' })
    expect(recall.items).toHaveLength(1)
    expect(recall.timedOut).toBe(false)
  })

  it('serializes concurrent writers and deduplicates races across two connections', async () => {
    const first = client()
    const second = client()
    await Promise.all([first.ready(), second.ready()])
    const inputs = Array.from({ length: 80 }, (_, i) => observation(i))
    const results = await Promise.all(inputs.flatMap(event => [first.ingest(event), second.ingest(event)]))
    expect(results.filter(result => result.status === 'inserted')).toHaveLength(80)
    expect(results.filter(result => result.status === 'duplicate')).toHaveLength(80)
    expect((await first.exportUser('user')).tables.events).toHaveLength(80)
  })

  it('returns an empty result by the deadline while the database is locked', async () => {
    const memory = client()
    await memory.ready()
    await memory.ingest(observation(1))
    const lock = new DatabaseSync(join(folder, 'memory.db'))
    lock.exec('BEGIN IMMEDIATE')
    const queuedWrite = memory.ingest(observation(2))
    let ticks = 0
    const heartbeat = setInterval(() => ticks++, 2)
    const started = performance.now()
    const recall = await memory.recall({ userId: 'user', characterId: 'mura', query: 'astronomy', deadlineMs: 15 })
    const elapsed = performance.now() - started
    clearInterval(heartbeat)
    lock.exec('ROLLBACK')
    lock.close()
    await queuedWrite
    expect(recall.items).toHaveLength(0)
    expect(recall.timedOut).toBe(true)
    expect(elapsed).toBeLessThan(100)
    expect(ticks).toBeGreaterThan(0)
    expect((await memory.exportUser('user')).tables.recalls).toHaveLength(0)
  })

  it('counts queue and startup time and drops late results', async () => {
    const memory = client()
    const early = await memory.recall({ userId: 'user', characterId: 'mura', query: 'astronomy', deadlineMs: 1 })
    expect(early.timedOut).toBe(true)
    await memory.ready()
    expect((await memory.exportUser('user')).tables.recalls).toHaveLength(0)
    expect((await memory.recall({ userId: 'user', characterId: 'mura', query: 'astronomy', deadlineMs: 0 })).timedOut).toBe(true)
    await memory.close()
    expect((await memory.recall({ userId: 'user', characterId: 'mura', query: 'astronomy' })).items).toHaveLength(0)
  })

  it('rejects results delivered after the deadline when the main event loop was busy', async () => {
    const memory = client()
    await memory.ready()
    await memory.ingest(observation(1))
    const recall = memory.recall({ userId: 'user', characterId: 'mura', query: 'astronomy', deadlineMs: 20 })
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    expect((await recall).timedOut).toBe(true)
    expect((await memory.exportUser('user')).tables.recalls).toHaveLength(0)
  })

  it('upgrades a populated v1 database and rebuilds FTS without changing data', () => {
    const path = join(folder, 'migration.db')
    const database = new DatabaseSync(path)
    database.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at INTEGER NOT NULL) STRICT')
    database.exec(migrations[0].sql)
    database.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(1, createHash('sha256').update(migrations[0].sql).digest('hex'), Date.now())
    database.exec('PRAGMA user_version=1')
    database.prepare(`INSERT INTO items(id,user_id,character_id,scope,scope_key,kind,category,original_text,normalized_search_text,language,
      confidence,salience,surprise,stability,difficulty,last_review,occurred_at,recorded_at,updated_at)
      VALUES('item','user','mura','character','char:mura','episode','conversation','We discussed astronomy.','we discussed astronomy.','en',0.9,0.5,0,3,5,0,0,0,0)`).run()
    database.close()
    const upgraded = new SQLiteMemoryStore(path)
    try {
      expect(upgraded.exportUser('user').schemaVersion).toBe(2)
      expect(upgraded.recall({ userId: 'user', characterId: 'mura', query: 'astronomy' }).items).toHaveLength(1)
    }
    finally {
      upgraded.close()
    }
  })

  it('rejects incomplete and future migration histories without partially upgrading them', () => {
    const path = join(folder, 'corrupt.db')
    const database = new DatabaseSync(path)
    database.exec('PRAGMA user_version=1')
    database.close()
    expect(() => new SQLiteMemoryStore(path)).toThrow('incomplete')
    const future = new DatabaseSync(join(folder, 'future.db'))
    future.exec('PRAGMA user_version=999')
    future.close()
    expect(() => new SQLiteMemoryStore(join(folder, 'future.db'))).toThrow('Unsupported')
  })

  it('rejects altered migration checksums and corrupt database files', () => {
    const path = join(folder, 'checksum.db')
    const store = new SQLiteMemoryStore(path)
    store.close()
    const database = new DatabaseSync(path)
    database.exec('UPDATE schema_migrations SET checksum=\'altered\' WHERE version=1')
    database.close()
    expect(() => new SQLiteMemoryStore(path)).toThrow('checksum mismatch')
    const corrupt = join(folder, 'corrupt-file.db')
    writeFileSync(corrupt, 'not a sqlite database')
    expect(() => new SQLiteMemoryStore(corrupt)).toThrow('not a database')
  })

  it('normalizes markers, unclosed reasoning and Unicode without exposing hidden text', () => {
    expect(normalizeText('[10:20] <|ACT:smile|> Ｒｉｋｏｎ  loves coffee')).toBe('rikon loves coffee')
    expect(normalizeText('Hello <think>hidden unfinished')).toBe('hello')
    expect(canonicalIdentity({ ...observation(1), sessionId: 'session:1', messageId: 'msg:1' })).toBe('airi:session%3A1:msg:msg%3A1')
  })
})
