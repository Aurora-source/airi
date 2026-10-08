import type { InjectedUnit } from '../budget/budgeter'
import type { CompanionConfig } from '../config/config'
import type { GatewayTurn, TurnHooks } from '../gateway/turn-hooks'
import type { MemoryPorts } from './memory'

import { dirname, join } from 'node:path'

import { MemoryClient } from '../memory/client'
import { ChannelObserver } from './channel-observer'
import { CompanionMemory } from './memory'
import { createPrivateDirectory } from './private-directory'
import { turnIdentityOf } from './turn-identity'

export interface CompanionRuntimeOptions {
  config: CompanionConfig
  /** The Core home. The default memory database lives below it. */
  home: string
  /** Token of AIRI's server channel, when it requires one. */
  channelToken?: string
  /** Receives one line per background failure. Lines hold ids and reasons, never memory or screen text. */
  report?: (message: string) => void
  /** Tests replace the memory worker. */
  memoryPorts?: MemoryPorts
  /** Tests replace the clock. */
  now?: () => number
  /** Tests start without the server channel. */
  channel?: boolean
}

/**
 * Owns the companion services next to the gateway: memory and the AIRI server channel observer.
 * It implements the gateway's turn hooks. Start it before the gateway listens and close it after the gateway closed.
 *
 * Call stack:
 *
 * main (../bin/run)
 *   -> {@link CompanionRuntime.open}
 *     -> MemoryClient.ready / CompanionMemory.startConsolidation / ChannelObserver.start
 * proxyChatCompletion (../gateway/chat-completions)
 *   -> {@link CompanionRuntime.begin}
 */
export class CompanionRuntime implements TurnHooks {
  private closed = false

  private constructor(
    readonly memory: CompanionMemory | undefined,
    private readonly client: MemoryClient | undefined,
    private readonly channel: ChannelObserver | undefined,
  ) {}

  static async open(options: CompanionRuntimeOptions): Promise<CompanionRuntime> {
    const { config } = options
    let client: MemoryClient | undefined
    let ports = options.memoryPorts
    if (config.memory.enabled && !ports) {
      const path = config.memory.path ?? join(options.home, 'memory', 'companion-memory.sqlite')
      await createPrivateDirectory(dirname(path))
      client = new MemoryClient(path)
      // Readiness is awaited here, so no chat turn spends its recall deadline on worker startup.
      await client.ready()
      ports = client
    }
    const memory = config.memory.enabled && ports
      ? new CompanionMemory(ports, {
          userId: config.memory.userId,
          recallDeadlineMs: config.memory.recallDeadlineMs,
          maxItems: config.memory.maxItems,
          maxBytes: config.memory.maxBytes,
          now: options.now,
          report: options.report,
        })
      : undefined
    memory?.startConsolidation(config.memory.consolidateEveryMs, config.memory.consolidateBatch)
    const channel = memory && config.channel.enabled && options.channel !== false
      ? new ChannelObserver(memory, { url: config.channel.url, token: options.channelToken, now: options.now, report: options.report })
      : undefined
    channel?.start()
    return new CompanionRuntime(memory, client, channel)
  }

  /** Builds the memory block of one AIRI chat request. A request without AIRI's turn identity gets nothing. */
  async begin(request: Parameters<TurnHooks['begin']>[0]): Promise<GatewayTurn | undefined> {
    if (this.closed)
      return undefined
    const identity = turnIdentityOf(request.headers)
    if (!identity || !this.memory)
      return undefined
    const units: InjectedUnit[] = []
    const memoryTurn = await this.memory.begin(identity, request.body)
    if (memoryTurn.unit)
      units.push(memoryTurn.unit)
    return { units, finish: outcome => memoryTurn.finish(outcome) }
  }

  async close(): Promise<void> {
    if (this.closed)
      return
    this.closed = true
    this.channel?.close()
    this.memory?.stopConsolidation()
    await this.client?.close()
  }
}
