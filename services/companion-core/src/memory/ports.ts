/** Transport-neutral contracts for local memory and future storage adapters. */
export type EventKind = 'user_text' | 'user_voice' | 'assistant' | 'spark_reaction' | 'observation' | 'watch_milestone' | 'memory_command'
export type Attribution = 'user_said' | 'observed' | 'inferred'
export type Category = 'identity' | 'preference' | 'interest' | 'goal' | 'stable_fact' | 'personality' | 'guideline' | 'relationship' | 'nickname' | 'inside_joke' | 'promise' | 'open_thread' | 'watch_session' | 'experience'
export type Scope = 'global' | 'character'

/** Semantic keys and values come from an explicit command or an extraction adapter, never from text hashing. */
export interface FactClaim {
  key: string
  value: string
  text: string
  category: Category
  attribution: Attribution
  scope?: Scope
  aboutUser?: boolean
  refersToCharacter?: boolean
  correction?: boolean
  cardinality?: 'single' | 'set'
  confidence?: number
  validFrom?: number
  validTo?: number
}

export interface ToolEvidence {
  callId: string
  name: string
  outcome: 'success' | 'failed' | 'cancelled'
  text: string
}

/** AIRI IDs describe persisted messages. Gateway request IDs describe attempts at the same logical request. */
export interface MemoryObservation {
  userId: string
  characterId: string
  source: 'gateway' | 'airi' | 'spark' | 'admin'
  kind: EventKind
  text: string
  language?: string
  occurredAt: number
  sessionId?: string
  messageId?: string
  turnId?: string
  sparkId?: string
  requestId?: string
  completion?: 'complete' | 'incomplete'
  topic?: string
  boundary?: 'topic' | 'task' | 'watch_start' | 'watch_stop'
  claims?: FactClaim[]
  tools?: ToolEvidence[]
  salience?: number
  surprise?: number
  relationship?: Partial<Record<'familiarity' | 'closeness' | 'trust' | 'playfulness', number>>
}

export interface IngestResult {
  status: 'inserted' | 'duplicate' | 'promoted' | 'ignored' | 'forgotten' | 'invalid' | 'private'
  eventId?: string
  reason?: string
}

export interface RecallRequest {
  userId: string
  characterId: string
  query: string
  /** @default 5 */
  maxItems?: number
  /** UTF-8 bytes, including instructions and labels. @default 2400 */
  maxBytes?: number
  /** Includes queue time and database work. @default 150 */
  deadlineMs?: number
  /** Historical facts use their validity interval at this wall-clock timestamp. */
  asOf?: number
}

export interface Provenance {
  eventId: string
  source: string
  authority: string
  attribution: Attribution
  occurredAt: number
  invalidated: boolean
}

export interface MemoryItem {
  id: string
  userId: string
  characterId: string | null
  scope: Scope
  kind: 'fact' | 'episode' | 'relationship'
  category: string
  originalText: string
  normalizedSearchText: string
  language: string
  state: 'active' | 'contested' | 'superseded'
  confidence: number
  pinned: boolean
  stability: number
  difficulty: number
  repetitions: number
  lastReview: number
  occurredAt: number
  recordedAt: number
  updatedAt: number
  validFrom: number | null
  validTo: number | null
  supersededBy: string | null
  semanticKey: string | null
  semanticValue: string | null
  invalidated: boolean
  provenance: Provenance[]
}

export interface RecallResult {
  items: MemoryItem[]
  prompt: string
  recallId?: string
  elapsedMs: number
  timedOut: boolean
}

export interface InspectRequest {
  userId: string
  characterId: string
  kind?: MemoryItem['kind']
  /** @default 50, capped at 100 */
  limit?: number
  offset?: number
}

export interface AdminTarget {
  userId: string
  itemId: string
}

export interface EditRequest extends AdminTarget {
  text?: string
  value?: string
  confidence?: number
  pinned?: boolean
  /** Explicit user confirmation rejects overlapping alternatives, including their historical claims. */
  resolveConflict?: boolean
}

/** Exports retain normalized rows, provenance, migration history and content-free replay tombstones. */
export interface MemoryExport {
  format: 'companion-memory-v1'
  schemaVersion: number
  exportedAt: number
  userId: string
  tables: Record<string, Record<string, string | number | null>[]>
}

/** Observers report availability intervals so expiry cannot silently admit interrupted or unpersisted turns. */
export interface MemoryEventPort {
  ingest: (observation: MemoryObservation) => Promise<IngestResult>
  setAuthorityAvailable: (userId: string, characterId: string, available: boolean) => Promise<void>
}

/** Empty recall is safe on timeout. Returned content is memory evidence, never a live observation or instruction. */
export interface MemoryQueryPort {
  recall: (request: RecallRequest) => Promise<RecallResult>
}

/** Adapters authenticate user ownership before calling these local privileged controls. */
export interface MemoryAdminPort {
  inspect: (request: InspectRequest) => Promise<MemoryItem[]>
  edit: (request: EditRequest) => Promise<MemoryItem | null>
  delete: (target: AdminTarget) => Promise<boolean>
  forget: (target: AdminTarget) => Promise<boolean>
  setPrivateMode: (userId: string, enabled: boolean) => Promise<void>
  exportUser: (userId: string) => Promise<MemoryExport>
  backup: (destination: string) => Promise<void>
}

export interface ConsolidationResult {
  settled: number
  consolidated: number
  degraded: number
  discarded: number
}

/** Review follows actual use or user engagement. Injection alone never reinforces memory. */
export interface MemoryConsolidationPort {
  consolidate: (limit?: number) => Promise<ConsolidationResult>
  review: (userId: string, recallId: string, usedItemIds: string[]) => Promise<boolean>
}
