import type { Operations, WorkerRequest, WorkerResponse } from './worker-protocol'

import { setTimeout } from 'node:timers/promises'
import { parentPort, workerData } from 'node:worker_threads'

import { errorMessageFrom } from '@moeru/std'

import { SQLiteMemoryStore } from './sqlite-store'

/**
 * Owns database IO on one thread. Requests are serialized and queue time counts toward recall deadlines.
 *
 * Call stack:
 *
 * MemoryClient (./client)
 *   -> worker-bootstrap.mjs
 *     -> SQLiteMemoryStore (./sqlite-store)
 */
async function start(): Promise<void> {
  if (!parentPort)
    throw new Error('Memory worker requires a parent thread')
  const port = parentPort
  const config = workerData as { databasePath: string }
  function busy(error: unknown): boolean {
    return error instanceof Error && 'errcode' in error && error.errcode === 5
  }
  async function retry<T>(operation: () => T, attempts: number, deadlineAt: number): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return operation()
      }
      catch (error) {
        if (!busy(error) || attempt >= attempts || Date.now() >= deadlineAt)
          throw error
        // Separate connections can race during WAL setup or BEGIN IMMEDIATE. Failed transactions leave no partial writes.
        await setTimeout(5 * (attempt + 1))
      }
    }
  }
  const store = await retry(() => new SQLiteMemoryStore(config.databasePath), 10, Date.now() + 5000)
  function dispatch(request: WorkerRequest): Operations[keyof Operations]['result'] {
    switch (request.operation) {
      case 'ingest': return store.ingest(...request.args)
      case 'setAuthorityAvailable': return store.setAuthorityAvailable(...request.args)
      case 'recall': return store.recall(request.args[0], request.deadlineAt)
      case 'acceptRecall': return store.acceptRecall(...request.args)
      case 'inspect': return store.inspect(...request.args)
      case 'edit': return store.edit(...request.args)
      case 'delete': return store.delete(...request.args)
      case 'forget': return store.forget(...request.args)
      case 'setPrivateMode': return store.setPrivateMode(...request.args)
      case 'exportUser': return store.exportUser(...request.args)
      case 'backup': return store.backup(...request.args)
      case 'consolidate': return store.consolidate(...request.args)
      case 'review': return store.review(...request.args)
      case 'close': return store.close()
    }
  }
  let queue = Promise.resolve()
  port.on('message', (request: WorkerRequest) => {
    queue = queue.then(async () => {
      let response: WorkerResponse
      try {
        const value = await retry(() => dispatch(request), 5, request.deadlineAt)
        response = { type: 'result', id: request.id, value }
      }
      catch (error) {
        response = { type: 'error', id: request.id, error: errorMessageFrom(error) ?? 'Memory operation failed' }
      }
      port.postMessage(response)
      if (request.operation === 'close')
        port.close()
    })
  })
  port.postMessage({ type: 'ready' } satisfies WorkerResponse)
}

void start()
