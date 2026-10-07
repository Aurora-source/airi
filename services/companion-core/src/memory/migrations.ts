import type { DatabaseSync } from 'node:sqlite'

import { createHash } from 'node:crypto'

/** Ordered, immutable schema history. Checksums reject altered or incomplete migrations. */
export const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE events (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, character_id TEXT NOT NULL,
        canonical_id TEXT, match_key TEXT NOT NULL, request_id TEXT, session_id TEXT,
        source TEXT NOT NULL, kind TEXT NOT NULL,
        authority TEXT NOT NULL CHECK(authority IN ('provisional','authoritative','degraded')),
        original_text TEXT NOT NULL, normalized_search_text TEXT NOT NULL, language TEXT NOT NULL,
        occurred_at INTEGER NOT NULL, observed_at INTEGER NOT NULL, recorded_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, admitted INTEGER NOT NULL DEFAULT 0 CHECK(admitted IN (0,1)),
        payload_json TEXT NOT NULL, UNIQUE(user_id, canonical_id)
      ) STRICT;
      CREATE UNIQUE INDEX event_request ON events(user_id,character_id,kind,request_id) WHERE request_id IS NOT NULL;
      CREATE INDEX event_match ON events(user_id,character_id,match_key,occurred_at);
      CREATE INDEX event_expiry ON events(authority,observed_at);
      CREATE TABLE event_sources (
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        source TEXT NOT NULL, observed_at INTEGER NOT NULL,
        PRIMARY KEY(event_id,source)
      ) STRICT;
      CREATE TABLE request_receipts (
        user_id TEXT NOT NULL, character_id TEXT NOT NULL, kind TEXT NOT NULL, request_id TEXT NOT NULL,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        strength TEXT NOT NULL CHECK(strength IN ('strong','correlated')),
        PRIMARY KEY(user_id,character_id,kind,request_id)
      ) STRICT;
      CREATE TABLE tool_evidence (
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        call_id TEXT NOT NULL, name TEXT NOT NULL, outcome TEXT NOT NULL,
        original_text TEXT NOT NULL, normalized_search_text TEXT NOT NULL, language TEXT NOT NULL,
        PRIMARY KEY(event_id,call_id)
      ) STRICT;
      CREATE TABLE items (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, character_id TEXT,
        scope TEXT NOT NULL CHECK(scope IN ('global','character')),
        scope_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('fact','episode','relationship')), category TEXT NOT NULL,
        original_text TEXT NOT NULL, normalized_search_text TEXT NOT NULL, language TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','contested','superseded')),
        confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
        salience REAL NOT NULL CHECK(salience BETWEEN 0 AND 1), surprise REAL NOT NULL CHECK(surprise BETWEEN 0 AND 1),
        stability REAL NOT NULL CHECK(stability > 0), difficulty REAL NOT NULL CHECK(difficulty BETWEEN 1 AND 10),
        last_review INTEGER NOT NULL, reps INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
        occurred_at INTEGER NOT NULL, recorded_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        CHECK((scope='global' AND character_id IS NULL AND scope_key='global' AND kind='fact')
          OR (scope='character' AND character_id IS NOT NULL AND scope_key='char:'||character_id))
      ) STRICT;
      CREATE INDEX item_scope ON items(user_id,scope_key,kind,state);
      CREATE TABLE facts (
        item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
        semantic_key TEXT NOT NULL, normalized_value TEXT NOT NULL, fingerprint TEXT NOT NULL,
        cardinality TEXT NOT NULL CHECK(cardinality IN ('single','set')),
        valid_from INTEGER NOT NULL, valid_to INTEGER,
        superseded_by TEXT REFERENCES items(id) ON DELETE SET NULL,
        invalidated INTEGER NOT NULL DEFAULT 0 CHECK(invalidated IN (0,1)),
        CHECK(valid_to IS NULL OR valid_to >= valid_from)
      ) STRICT;
      CREATE INDEX fact_semantics ON facts(semantic_key,normalized_value);
      CREATE TABLE sources (
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        attribution TEXT NOT NULL CHECK(attribution IN ('user_said','observed','inferred')),
        invalidated INTEGER NOT NULL DEFAULT 0 CHECK(invalidated IN (0,1)),
        PRIMARY KEY(item_id,event_id)
      ) STRICT;
      CREATE INDEX source_event ON sources(event_id);
      CREATE TABLE claim_receipts (
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL, PRIMARY KEY(event_id,fingerprint)
      ) STRICT;
      CREATE TABLE episodes (
        item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
        session_id TEXT, topic TEXT NOT NULL,
        started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('open','settled','consolidated'))
      ) STRICT;
      CREATE INDEX episode_time ON episodes(state,ended_at);
      CREATE TABLE episode_events (
        item_id TEXT NOT NULL REFERENCES episodes(item_id) ON DELETE CASCADE,
        event_id TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
        PRIMARY KEY(item_id,event_id)
      ) STRICT;
      CREATE TABLE relationship (
        item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL, character_id TEXT NOT NULL,
        familiarity REAL NOT NULL DEFAULT 0 CHECK(familiarity BETWEEN 0 AND 1),
        closeness REAL NOT NULL DEFAULT 0 CHECK(closeness BETWEEN 0 AND 1),
        trust REAL NOT NULL DEFAULT 0 CHECK(trust BETWEEN 0 AND 1),
        playfulness REAL NOT NULL DEFAULT 0 CHECK(playfulness BETWEEN 0 AND 1),
        UNIQUE(user_id,character_id)
      ) STRICT;
      CREATE TABLE relationship_changes (
        event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL REFERENCES relationship(item_id) ON DELETE CASCADE,
        familiarity REAL NOT NULL, closeness REAL NOT NULL, trust REAL NOT NULL, playfulness REAL NOT NULL
      ) STRICT;
      CREATE TABLE recalls (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, character_id TEXT NOT NULL,
        occurred_at INTEGER NOT NULL, reviewed INTEGER NOT NULL DEFAULT 0 CHECK(reviewed IN (0,1))
      ) STRICT;
      CREATE TABLE recall_items (
        recall_id TEXT NOT NULL REFERENCES recalls(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        PRIMARY KEY(recall_id,item_id)
      ) STRICT;
      CREATE TABLE deletions (
        user_id TEXT NOT NULL, scope_key TEXT NOT NULL, kind TEXT NOT NULL,
        fingerprint TEXT NOT NULL, forgotten_at INTEGER NOT NULL,
        PRIMARY KEY(user_id,scope_key,kind,fingerprint)
      ) STRICT;
      CREATE TABLE authority_windows (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, character_id TEXT NOT NULL,
        started_at INTEGER NOT NULL, ended_at INTEGER,
        CHECK(ended_at IS NULL OR ended_at >= started_at)
      ) STRICT;
      CREATE INDEX authority_scope ON authority_windows(user_id,character_id,started_at,ended_at);
      CREATE UNIQUE INDEX authority_connected ON authority_windows(user_id,character_id) WHERE ended_at IS NULL;
      CREATE TABLE privacy (
        user_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
      ) STRICT;
      CREATE TABLE jobs (
        item_id TEXT PRIMARY KEY REFERENCES episodes(item_id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('pending','leased','done')),
        lease_until INTEGER, updated_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 2,
    sql: `
      CREATE VIRTUAL TABLE fts_index USING fts5(
        normalized_search_text, category, user_id UNINDEXED, scope_key UNINDEXED,
        content='items', content_rowid='rowid', tokenize='porter unicode61'
      );
      CREATE TRIGGER item_insert AFTER INSERT ON items BEGIN
        INSERT INTO fts_index(rowid,normalized_search_text,category,user_id,scope_key)
          VALUES(new.rowid,new.normalized_search_text,new.category,new.user_id,new.scope_key);
      END;
      CREATE TRIGGER item_delete AFTER DELETE ON items BEGIN
        INSERT INTO fts_index(fts_index,rowid,normalized_search_text,category,user_id,scope_key)
          VALUES('delete',old.rowid,old.normalized_search_text,old.category,old.user_id,old.scope_key);
      END;
      CREATE TRIGGER item_update AFTER UPDATE ON items BEGIN
        INSERT INTO fts_index(fts_index,rowid,normalized_search_text,category,user_id,scope_key)
          VALUES('delete',old.rowid,old.normalized_search_text,old.category,old.user_id,old.scope_key);
        INSERT INTO fts_index(rowid,normalized_search_text,category,user_id,scope_key)
          VALUES(new.rowid,new.normalized_search_text,new.category,new.user_id,new.scope_key);
      END;
      INSERT INTO fts_index(fts_index) VALUES('rebuild');
    `,
  },
] as const

/** Applies schema upgrades atomically and validates the full history before opening the store. */
export function migrateDatabase(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    database.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT')
    const version = Number(database.prepare('PRAGMA user_version').get()?.user_version)
    const history = database.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all()
    if (version > migrations.length || history.length !== version)
      throw new Error('Unsupported or incomplete memory schema history')
    for (const migration of migrations) {
      const checksum = createHash('sha256').update(migration.sql).digest('hex')
      if (migration.version <= version) {
        if (history[migration.version - 1]?.checksum !== checksum)
          throw new Error(`Memory migration ${migration.version} checksum mismatch`)
      }
      else {
        database.exec(migration.sql)
        database.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(migration.version, checksum, Date.now())
        database.exec(`PRAGMA user_version=${migration.version}`)
      }
    }
    database.exec('COMMIT')
  }
  catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}
