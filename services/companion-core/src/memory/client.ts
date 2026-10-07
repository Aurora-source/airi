import type { AdminTarget, EditRequest, InspectRequest, MemoryAdminPort, MemoryConsolidationPort, MemoryEventPort, MemoryObservation, MemoryQueryPort, RecallRequest, RecallResult } from './ports'
import type { Operations, WorkerResponse } from './worker-protocol'

import { Worker } from 'node:worker_threads'

import { errorMessageFrom } from '@moeru/std'

interface Pending {
  resolve: (value: Operations[keyof Operations]['result']) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  deadlineAt: number
}

class DeadlineError extends Error {}

/**
 * Implements all memory ports without blocking the caller's event loop on SQLite.
 * One instance owns one worker. The runtime owner awaits ready and closes it on shutdown.
 * Caller deadlines include startup and queue time. Expired results are discarded.
 */
export class MemoryClient implements MemoryEventPort, MemoryQueryPort, MemoryAdminPort, MemoryConsolidationPort {
  private readonly worker: Worker
  private readonly pending = new Map<number, Pending>()
  private readonly initialized: Promise<void>
  private closed = false
  private sequence = 0

  constructor(databasePath: string) {
    this.worker = new Worker(new URL('./worker-bootstrap.mjs', import.meta.url), { workerData: { databasePath }, execArgv: [] })
    this.initialized = new Promise((resolve, reject) => {
      const startup = setTimeout(() => {
        const error = new Error('Memory worker startup exceeded 10 seconds')
        reject(error)
        this.fail(error)
        void this.worker.terminate()
      }, 10_000)
      this.worker.on('message', (response: WorkerResponse) => {
        if (response.type === 'ready') {
          clearTimeout(startup)
          resolve()
          return
        }
        const pending = this.pending.get(response.id)
        if (!pending)
          return
        clearTimeout(pending.timer)
        this.pending.delete(response.id)
        if (Date.now() > pending.deadlineAt)
          pending.reject(new DeadlineError('Memory result arrived after its deadline'))
        else if (response.type === 'error')
          pending.reject(new Error(response.error))
        else
          pending.resolve(response.value)
      })
      this.worker.on('error', (error) => {
        clearTimeout(startup)
        reject(error)
        this.fail(error instanceof Error ? error : new Error(errorMessageFrom(error) ?? 'Memory worker failed'))
      })
      this.worker.on('exit', (code) => {
        clearTimeout(startup)
        const error = new Error(`Memory worker exited (${code})`)
        reject(error)
        this.fail(error)
      })
    })
    // Recall is allowed before ready. Its own deadline handles unavailable startup.
    void this.initialized.catch(() => {})
  }

  ready(): Promise<void> {
    return this.initialized
  }

  private fail(error: Error): void {
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private request<K extends keyof Operations>(operation: K, args: Operations[K]['args'], timeout = 30_000): Promise<Operations[K]['result']> {
    if (this.closed)
      return Promise.reject(new Error('Memory worker is closed'))
    const id = ++this.sequence
    const deadlineAt = Date.now() + timeout
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new DeadlineError('Memory request deadline exceeded'))
      }, timeout)
      this.pending.set(id, { resolve: value => resolve(value as Operations[K]['result']), reject, timer, deadlineAt })
      try {
        this.worker.postMessage({ id, operation, args, deadlineAt })
      }
      catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  ingest(observation: MemoryObservation) {
    return this.request('ingest', [observation])
  }

  setAuthorityAvailable(userId: string, characterId: string, available: boolean) {
    return this.request('setAuthorityAvailable', [userId, characterId, available])
  }

  async recall(request: RecallRequest): Promise<RecallResult> {
    const started = performance.now()
    const requested = request.deadlineMs ?? 150
    const deadline = Number.isFinite(requested) ? Math.max(0, Math.min(1000, requested)) : 150
    if (deadline === 0)
      return { items: [], prompt: '', elapsedMs: performance.now() - started, timedOut: true }
    try {
      const result = await this.request('recall', [request], deadline)
      if (performance.now() - started >= deadline)
        return { items: [], prompt: '', elapsedMs: performance.now() - started, timedOut: true }
      if (result.recallId)
        void this.request('acceptRecall', [request.userId, result.recallId, Date.now()]).catch(() => {})
      return { ...result, elapsedMs: performance.now() - started }
    }
    catch (error) {
      // Chat continues without memory on worker failure or timeout. Mutation errors still reach the caller.
      return { items: [], prompt: '', elapsedMs: performance.now() - started, timedOut: error instanceof DeadlineError }
    }
  }

  inspect(request: InspectRequest) {
    return this.request('inspect', [request])
  }

  edit(request: EditRequest) {
    return this.request('edit', [request])
  }

  delete(target: AdminTarget) {
    return this.request('delete', [target])
  }

  forget(target: AdminTarget) {
    return this.request('forget', [target])
  }

  setPrivateMode(userId: string, enabled: boolean) {
    return this.request('setPrivateMode', [userId, enabled])
  }

  exportUser(userId: string) {
    return this.request('exportUser', [userId])
  }

  backup(destination: string) {
    return this.request('backup', [destination])
  }

  consolidate(limit?: number) {
    return this.request('consolidate', [limit])
  }

  review(userId: string, recallId: string, usedItemIds: string[]) {
    return this.request('review', [userId, recallId, usedItemIds])
  }

  async close(): Promise<void> {
    if (this.closed)
      return
    try {
      await this.request('close', [], 1000)
    }
    finally {
      this.fail(new Error('Memory worker closed'))
      await this.worker.terminate()
    }
  }
}
