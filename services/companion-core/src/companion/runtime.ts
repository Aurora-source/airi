import type { InjectedUnit } from '../budget/budgeter'
import type { CompanionConfig } from '../config/config'
import type { GatewayRuntime } from '../gateway/runtime'
import type { GatewayTurn, TurnHooks } from '../gateway/turn-hooks'
import type { MemoryPorts } from './memory'
import type { ScreenBackend } from './perception'

import process from 'node:process'

import { dirname, join } from 'node:path'

import { MemoryClient } from '../memory/client'
import { awarenessUnit } from './awareness'
import { ChannelObserver } from './channel-observer'
import { CompanionMemory } from './memory'
import { CompanionPerception } from './perception'
import { createPrivateDirectory } from './private-directory'
import { turnIdentityOf } from './turn-identity'
import { WindowsScreenCaptureBackend } from './windows-capture'

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
  /** Tests replace the screen capture backend. @default the Windows capture helper on Windows, none elsewhere */
  captureBackend?: ScreenBackend
}

/**
 * Owns the companion services next to the gateway: memory, the AIRI server channel observer, and screen perception.
 * It implements the gateway's turn hooks. Open it before the gateway listens and attach it after.
 * Shut perception down before the gateway closes, and close the rest after the gateway closed.
 *
 * Call stack:
 *
 * main (../bin/run)
 *   -> {@link CompanionRuntime.open}
 *     -> MemoryClient.ready / CompanionMemory.startConsolidation / ChannelObserver.start / CompanionPerception
 *   -> {@link CompanionRuntime.attach} -> CompanionPerception.attach
 * proxyChatCompletion (../gateway/chat-completions)
 *   -> {@link CompanionRuntime.begin} -> CompanionMemory.begin / awarenessUnit
 */
export class CompanionRuntime implements TurnHooks {
  private closed = false

  private constructor(
    readonly memory: CompanionMemory | undefined,
    private readonly client: MemoryClient | undefined,
    private readonly channel: ChannelObserver | undefined,
    readonly perception: CompanionPerception | undefined,
    private readonly now: () => number,
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
    const perception = openPerception(options, memory)
    return new CompanionRuntime(memory, client, channel, perception, options.now ?? Date.now)
  }

  /** Connects perception to the gateway's router. Call it once the gateway listens. */
  attach(runtime: GatewayRuntime): void {
    this.perception?.attach(runtime)
  }

  /**
   * Builds the memory and NOW blocks of one AIRI chat request. A request without AIRI's turn identity gets nothing.
   * NOW is read when the request arrives, so a tool round of a long turn never sees an expired screen state.
   */
  async begin(request: Parameters<TurnHooks['begin']>[0]): Promise<GatewayTurn | undefined> {
    if (this.closed)
      return undefined
    const identity = turnIdentityOf(request.headers)
    if (!identity || (!this.memory && !this.perception))
      return undefined
    const units: InjectedUnit[] = []
    const memoryTurn = await this.memory?.begin(identity, request.body)
    if (memoryTurn?.unit)
      units.push(memoryTurn.unit)
    const awareness = this.perception && awarenessUnit(this.perception.current(), this.now())
    if (awareness)
      units.push(awareness)
    return { units, finish: outcome => memoryTurn?.finish(outcome) }
  }

  async close(): Promise<void> {
    if (this.closed)
      return
    this.closed = true
    await this.perception?.shutdown()
    this.channel?.close()
    this.memory?.stopConsolidation()
    await this.client?.close()
  }
}

/** Perception needs a capture backend. Without one it stays off and says so once. */
function openPerception(options: CompanionRuntimeOptions, memory: CompanionMemory | undefined): CompanionPerception | undefined {
  const { perception: config } = options.config
  if (!config.enabled)
    return undefined
  let backend = options.captureBackend
  if (!backend && process.platform === 'win32') {
    backend = new WindowsScreenCaptureBackend({
      maxWidth: config.maxWidth,
      quality: config.jpegQuality,
      lists: { classifiedApps: config.privacy.classifiedApps, sensitiveApps: config.privacy.sensitiveApps },
      now: options.now,
    })
  }
  if (!backend) {
    options.report?.('perception: off, no screen capture backend on this platform')
    return undefined
  }
  return new CompanionPerception({ config, backend, activeTurn: () => memory?.activeTurn(), now: options.now })
}
