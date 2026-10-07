import type { AdminTarget, ConsolidationResult, EditRequest, IngestResult, InspectRequest, MemoryExport, MemoryItem, MemoryObservation, RecallRequest, RecallResult } from './ports'

/** Internal thread messages stay separate from public storage ports and external transport contracts. */
export interface Operations {
  ingest: { args: [MemoryObservation], result: IngestResult }
  setAuthorityAvailable: { args: [string, string, boolean], result: void }
  recall: { args: [RecallRequest], result: RecallResult }
  acceptRecall: { args: [string, string, number], result: boolean }
  inspect: { args: [InspectRequest], result: MemoryItem[] }
  edit: { args: [EditRequest], result: MemoryItem | null }
  delete: { args: [AdminTarget], result: boolean }
  forget: { args: [AdminTarget], result: boolean }
  setPrivateMode: { args: [string, boolean], result: void }
  exportUser: { args: [string], result: MemoryExport }
  backup: { args: [string], result: void }
  consolidate: { args: [number?], result: ConsolidationResult }
  review: { args: [string, string, string[]], result: boolean }
  close: { args: [], result: void }
}

export type WorkerRequest = {
  [K in keyof Operations]: { id: number, operation: K, args: Operations[K]['args'], deadlineAt: number }
}[keyof Operations]

export type WorkerResponse
  = | { type: 'ready' }
    | { type: 'result', id: number, value: Operations[keyof Operations]['result'] }
    | { type: 'error', id: number, error: string }
