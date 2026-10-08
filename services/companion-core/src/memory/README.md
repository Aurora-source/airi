# Companion memory foundation

This subsystem stores persistent companion memory in SQLite with FTS5.
It exposes ports for observers, recall, user controls and consolidation.
It has no runtime wiring, cloud extraction, embeddings or UI.

## Runtime and ownership

Use `MemoryClient` from `@proj-airi/companion-core/memory`.
The service owner chooses the database path and creates its parent directory.
Keep that directory private to the operating-system user.
The tested runtime is Node 22.22.2 with the repository's installed `tsx` loader.

```ts
import { MemoryClient } from '@proj-airi/companion-core/memory'

const memory = new MemoryClient(databasePath)
await memory.ready()
const result = await memory.recall({
  userId,
  characterId,
  query: 'What name do you call me?',
  deadlineMs: 150,
})
// The adapter passes result.prompt to the gateway as one bounded MemoryUnit.
await memory.close()
```

Each client owns one worker and database connection.
SQLite runs outside the caller's event loop.
Thread messages are internal, within one process.
External IPC and channel adapters retain AIRI's Eventa contracts.
Startup, queue time, query work and response delivery count toward recall deadlines.
If recall times out, it returns empty memory.
If the worker fails, recall returns empty memory and mutation calls reject.

## Ports

| Port | Operations |
| --- | --- |
| `MemoryEventPort` | `ingest`, `setAuthorityAvailable` |
| `MemoryQueryPort` | `recall` |
| `MemoryAdminPort` | `inspect`, `edit`, `delete`, `forget`, `setPrivateMode`, `exportUser`, `backup` |
| `MemoryConsolidationPort` | `consolidate`, `review` |

Port contracts contain no SQLite, provider or AIRI store types.
A future plast-mem adapter can replace storage behind these contracts.
Adapters authenticate user identity and bind the current AIRI card ID.
They must not accept another user's ID from model-generated tool arguments.

## Scope and claims

Retrieval reads global user memory plus the current character's memory.
Every query also filters by user ID.
The default claim scope is character.
Episodes, relationship state, nicknames, jokes, promises, watch sessions and shared experiences stay character-scoped.
Global categories cover identity, preferences, interests, goals, personality, guidelines and stable self-facts.
Global admission requires a user-authored self-statement without character references.
Explicit admin commands can promote stable self-facts.
The database enforces scope consistency.

Observers can supply structured `FactClaim` values.
`key` names the semantic slot. `value` identifies the normalized concept.
`text` preserves the readable claim.
For example, two phrasings with key `user.drink` and value `coffee` deduplicate.
Unstructured chatter creates episodes, not inferred facts.
This foundation does not claim automatic paraphrase understanding.
An extraction adapter can later supply claims through the same event port.

Single-valued overlapping claims with different values become contested.
Contested claims and their unsafe episode material are excluded from recall.
An explicit correction closes the old validity interval and supersedes it.
Nonoverlapping historical intervals remain independent.
Older corroborating evidence extends the existing interval and provenance.
Set-valued claims can coexist when the adapter selects `cardinality: 'set'`.

An admin edit can update text, semantic value, confidence and pinning.
Changing a semantic value requires new text.
`resolveConflict: true` confirms the selected candidate and rejects overlapping alternatives, including historical claims.
Rejected candidates stay inspectable with `invalidated: true`.
Changing a real fact over time uses an event correction, which preserves historical validity.
Text and value edits record admin evidence and invalidate the old summary's source attribution.

## Identity and admission

| Source event | Canonical identity |
| --- | --- |
| Persisted user text or voice | `airi:<sessionId>:msg:<messageId>` |
| Persisted assistant turn | `airi:<sessionId>:turn:<turnId>` |
| Spark reaction | `spark:<notifyId>` |
| Watch milestone | `watch:<watchEventId>` |
| Explicit memory command | `admin:<requestId>` |

Identifier components use percent encoding.
Canonical uniqueness includes user ownership.
User events require their persisted message ID, even when a turn ID exists.
Gateway events have no canonical ID.
They require a stable request ID shared across provider attempts.
Interrupted generations are rejected before writes.
Tool outcomes attach to assistant evidence by call ID.
They do not create separate memories.

The content match key hashes user, character, event kind and normalized visible text.
Normalization uses NFKC, removes ACT markers, reasoning and leading clock prefixes, and collapses whitespace.
User voice and text share the correlation kind.
Authoritative admission first checks the canonical ID.
It then promotes one unambiguous provisional match within 120 seconds and compatible session ownership.
Ambiguous text stays provisional.
Repeated persisted text with different canonical IDs remains separate evidence.

`request_receipts` distinguish strong request ownership from speculative text correlation.
A later authoritative identity can replace a speculative association.
It cannot move a strongly owned request to another persisted turn.
Promotion keeps the original event row and unions source provenance.
Claim receipts and unique episode links make admission idempotent.

After ten minutes, consolidation discards provisional events covered by an authoritative observer.
Uncovered events become degraded evidence with confidence capped at 0.5.
Observers report availability intervals with `setAuthorityAvailable`.
Only coverage inside the provisional window affects this decision.

## Schema and migrations

Version 1 defines the relational foundation.
Version 2 adds the FTS5 index, triggers and initial index rebuild.
Migration history has SHA-256 checksums.
Startup rejects altered, incomplete or future histories.
Each migration runs atomically.

| Table | Purpose |
| --- | --- |
| `events` | Canonical or provisional evidence, original text, normalized text, language and timestamps |
| `event_sources`, `request_receipts`, `tool_evidence` | Observer provenance, request ownership and tool outcomes |
| `items` | Shared scope, text, confidence, salience, surprise, pins and review state |
| `facts`, `claim_receipts` | Semantic identity, validity, supersession, invalidation and idempotent admission |
| `episodes`, `episode_events` | Segmentation state and source event links |
| `sources` | Item provenance and invalidated attribution |
| `relationship`, `relationship_changes` | Bounded character state and its event-level contributions |
| `recalls`, `recall_items` | Accepted recall receipts and reviewed items |
| `deletions` | Content-free fingerprints that block forgotten replay |
| `authority_windows`, `privacy`, `jobs` | Admission policy, private mode and leased consolidation |
| `schema_migrations` | Ordered checksummed migration history |
| `fts_index` | English lexical retrieval using Porter and unicode61 |

Text-bearing records retain `original_text`, `normalized_search_text` and `language`.
SQLite uses WAL, foreign keys, strict tables and secure deletion.
Existing backups retain their original content until the user deletes or replaces them.

## Retrieval and review

Recall searches FTS5 once, then scores at most 64 candidates.
Scope and validity filters run before candidate selection.
A CROSS JOIN keeps FTS outside the scope lookup to avoid repeated full FTS scans.
Scores combine lexical match, recency, salience, pins and retrievability.
Stable facts do not decay.
Relevant old episodes can still return when asked about directly.
No lexical match produces no injected memory.

Recall returns at most five items and 2,400 UTF-8 prompt bytes by default.
The byte limit includes memory instructions and labels.
Caller overrides are capped at five items, 8,000 bytes and a 1,000 ms deadline.
Recall provenance is capped at eight sources per item.
Inspection returns up to 100 items and 50 sources per item.
Exports retain complete provenance.
The prompt labels remembered and inferred content, with a date and scope.
It instructs the model to treat memory as quoted evidence and hedge uncertainty.

Queries prepare an ephemeral receipt.
The client accepts it only when the result arrives within the deadline.
Expired queries create no persistent recall receipt or reinforcement.
After use, the adapter calls `review(userId, recallId, usedItemIds)`.
The adapter derives used IDs from reply overlap or explicit user engagement.
Review applies once. Injection alone does not reinforce memory.

Episode retrievability follows `R = 1 / (1 + elapsedDays / (9 * stability))`.
Good use grows stability based on difficulty and the prior recall strength.
Ignored injection gets a smaller Hard review.
Surprise and salience increase initial stability.
This is an FSRS-like policy, not a trained FSRS model.

## Segmentation and consolidation

Episodes split on topic, task, watch boundaries, session changes and idle gaps over twenty minutes.
They settle after ten minutes of inactivity.
A bounded job pass rebuilds settled summaries from at most sixteen source events.
Each excerpt is capped at 400 characters.
Jobs carry leases and completed state, so restart or concurrent writers cannot consolidate twice.
The foundation uses deterministic summaries and supplied claims.
It does not invoke a reasoning provider or start local inference.

Relationship changes apply once per event and cap each delta at 0.05.
Familiarity, closeness, trust and playfulness stay between zero and one.
Deleting evidence recomputes remaining contributions.
Nicknames, jokes and open promises use character-scoped semantic claims with provenance and validity.

## User controls and backups

Private mode blocks ingestion, background admission, consolidation, recall tracking and reinforcement.
Recall can still read existing memory.
Explicit user edits, deletion and forgetting remain available.

Delete removes the item and source evidence that can reproduce it.
Forget also stores replay fingerprints.
Removing source evidence rebuilds or removes affected episodes and relationship state.
Removing a fact follows all its sources, including sources in other episodes.
Forgetting global facts removes equal semantic character copies and blocks re-import in every character.
These controls prioritize removal and can remove other claims derived from the same source event.
An adapter must explain this source cascade in the inspector.

`exportUser` returns a consistent, versioned relational JSON snapshot for one user.
`backup` uses `VACUUM INTO` to create a consistent SQLite file, including tombstones and migration history.
The backup operation requires a new destination file.
Restore by closing clients and opening the copied snapshot as the database path.

## Verification

```text
pnpm -F @proj-airi/companion-core test
pnpm -F @proj-airi/companion-core typecheck
pnpm exec eslint services/companion-core/src/memory services/companion-core/test/memory-*.test.ts services/companion-core/eval/memory/benchmark.ts
pnpm -F @proj-airi/companion-core exec tsx eval/memory/benchmark.ts 2000 <evidence.json>
```

The replay suite uses real SQLite and deterministic wall clocks.
Runtime tests use real workers, database locks, concurrent connections and deadline races.
Benchmarks measure a synthetic lexical workload.
The multi-day companion recall trial requires later runtime integration.
