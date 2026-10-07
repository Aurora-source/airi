// NOTICE:
// `node:sqlite` is experimental in Node 22 and prints an ExperimentalWarning once at startup.
// The workspace has no other SQLite binding, and the native `better-sqlite3` build is disabled in pnpm-workspace.yaml.
// Source/context: https://nodejs.org/api/sqlite.html
// Removal condition: none. Keep it when Node marks the module stable, and drop this comment then.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type CompanionDatabase = DatabaseSync

/**
 * Tables of the Companion Core state. `PRAGMA user_version` is the schema version.
 *
 * - `usage_event`: one row per provider request, for the minute and day windows of the quota ledger.
 *   `counted` is 0 for a request that the provider refused or never processed.
 * - `cooldown`: a model that must rest until `until_ms`, for example after a 429.
 * - `observed_limit`: the last rate-limit headers that a provider sent. They never replace the configured limits.
 * - `sticky_choice`: the model that serves a conversation, so that its character does not change between turns.
 * - `probe_result`: the last capability probe of a model.
 */
const SCHEMA_V1 = `
CREATE TABLE usage_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  counted INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX usage_event_scope_at ON usage_event (scope, at_ms);

CREATE TABLE cooldown (
  scope TEXT PRIMARY KEY,
  until_ms INTEGER NOT NULL,
  reason TEXT NOT NULL
);

CREATE TABLE observed_limit (
  scope TEXT PRIMARY KEY,
  limit_requests INTEGER,
  remaining_requests INTEGER,
  reset_requests_at_ms INTEGER,
  limit_tokens INTEGER,
  remaining_tokens INTEGER,
  reset_tokens_at_ms INTEGER,
  observed_at_ms INTEGER NOT NULL
);

CREATE TABLE sticky_choice (
  alias TEXT NOT NULL,
  conversation TEXT NOT NULL,
  model_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  chosen_at_ms INTEGER NOT NULL,
  last_used_at_ms INTEGER NOT NULL,
  PRIMARY KEY (alias, conversation)
);

CREATE TABLE probe_result (
  model_id TEXT PRIMARY KEY,
  probed_at_ms INTEGER NOT NULL,
  result_json TEXT NOT NULL
);
`

/**
 * Opens the state database, creates missing tables, and returns it.
 * `:memory:` gives a private in-memory database. Tests use it.
 */
export function openDatabase(path: string): CompanionDatabase {
  if (path !== ':memory:')
    mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA busy_timeout = 2000')
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
  }
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if (version === 0) {
    db.exec('BEGIN')
    try {
      db.exec(SCHEMA_V1)
      db.exec('PRAGMA user_version = 1')
      db.exec('COMMIT')
    }
    catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  else if (version !== 1) {
    db.close()
    throw new Error(`The state database has schema version ${version}, and this build reads version 1.`)
  }
  return db
}
