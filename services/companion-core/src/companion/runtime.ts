import type { InjectedUnit } from '../budget/budgeter'
import type { CompanionConfig } from '../config/config'
import type { DirectorClock } from '../director'
import type { GatewayRuntime } from '../gateway/runtime'
import type { GatewayTurn, TurnHooks } from '../gateway/turn-hooks'
import type { MediaSourceAdapter } from '../watch'
import type { CompanionDirectorOptions } from './director'
import type { MemoryPorts } from './memory'
import type { ScreenBackend } from './perception'
import type { CompanionWatchOptions } from './watch'

import process from 'node:process'

import { dirname, join } from 'node:path'

import { MemoryClient } from '../memory/client'
import { awarenessUnit } from './awareness'
import { ChannelObserver } from './channel-observer'
import { CompanionDirector } from './director'
import { CompanionMemory } from './memory'
import { CompanionPerception } from './perception'
import { createPrivateDirectory } from './private-directory'
import { turnIdentityOf } from './turn-identity'
import { CompanionWatch } from './watch'
import { WindowsScreenCaptureBackend } from './windows-capture'
import { isToolContinuation } from './wire-text'

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
  /** Tests replace the watch channel client, system audio capture, recognition, reaction output, and AniList transport. */
  watchPorts?: Pick<CompanionWatchOptions, 'createClient' | 'systemAudio' | 'recognition' | 'reactionOutput' | 'anilistTransport'>
  /** Desktop player and media server sources that the caller built from configuration and protected secrets. */
  mediaSources?: readonly MediaSourceAdapter[]
  /** Tests replace the Director's channel client and clock. */
  directorPorts?: Pick<CompanionDirectorOptions, 'createClient'> & { clock?: DirectorClock }
}

/**
 * Owns the companion services next to the gateway: memory, the AIRI server channel observer, screen perception,
 * Watch Together, and the Director host. It implements the gateway's turn hooks. Open it before the gateway listens
 * and attach it after. Shut the Director, watch, and perception down before the gateway closes, and close the rest
 * after the gateway closed.
 *
 * Call stack:
 *
 * main (../bin/run)
 *   -> {@link CompanionRuntime.open}
 *     -> MemoryClient.ready / CompanionMemory.startConsolidation / ChannelObserver.start / CompanionPerception
 *     -> CompanionDirector / CompanionWatch (reaction output through the Director's relay)
 *   -> {@link CompanionRuntime.attach} -> CompanionPerception.attach / CompanionWatch.attach / CompanionDirector.attach
 * proxyChatCompletion (../gateway/chat-completions)
 *   -> {@link CompanionRuntime.begin} -> CompanionDirector.beginTurn / CompanionMemory.begin / CompanionWatch.unit / awarenessUnit
 */
export class CompanionRuntime implements TurnHooks {
  private closed = false

  private constructor(
    readonly memory: CompanionMemory | undefined,
    private readonly client: MemoryClient | undefined,
    private readonly channel: ChannelObserver | undefined,
    readonly perception: CompanionPerception | undefined,
    readonly watch: CompanionWatch | undefined,
    readonly director: CompanionDirector | undefined,
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
    // The Director talks to the stage through the server channel. Without the channel it has no output.
    const director = config.director.enabled && config.channel.enabled && (options.channel !== false || options.directorPorts?.createClient)
      ? new CompanionDirector({ config, channelToken: options.channelToken, report: options.report, createClient: options.directorPorts?.createClient, clock: options.directorPorts?.clock })
      : undefined
    // Watch follows the extension through the server channel. Without the channel nothing can reach it.
    // Admitted reactions go to the Director's relay. A test output replaces it.
    const watch = config.watch.enabled && config.channel.enabled && (options.channel !== false || options.watchPorts?.createClient)
      ? new CompanionWatch({ config, channelToken: options.channelToken, memory, perception, now: options.now, report: options.report, mediaSources: options.mediaSources, reactionOutput: director?.reactionOutput(), ...options.watchPorts })
      : undefined
    director?.connect({ watch, perception, memory })
    return new CompanionRuntime(memory, client, channel, perception, watch, director, options.now ?? Date.now)
  }

  /**
   * Connects perception to the gateway's router and watch transcription to the gateway's own route.
   * Call it once the gateway listens.
   */
  attach(runtime: GatewayRuntime, gateway?: { baseURL: string, token: string }): void {
    this.perception?.attach(runtime)
    if (gateway) {
      this.watch?.attach(gateway)
      this.director?.attach(gateway)
    }
  }

  /**
   * Builds the memory, WATCH, and NOW blocks of one AIRI chat request. A request without AIRI's turn identity gets
   * nothing. WATCH and NOW are read when the request arrives, so a tool round of a long turn never sees expired state.
   * A new user turn counts as user speech for watch, so no reaction talks over it.
   */
  async begin(request: Parameters<TurnHooks['begin']>[0]): Promise<GatewayTurn | undefined> {
    if (this.closed)
      return undefined
    const identity = turnIdentityOf(request.headers)
    if (!identity || (!this.memory && !this.perception && !this.watch && !this.director))
      return undefined
    if (this.watch && !isToolContinuation(request.body))
      this.watch.userSpeech()
    const directorTurn = this.director?.beginTurn(identity, request.body)
    const units: InjectedUnit[] = []
    const memoryTurn = await this.memory?.begin(identity, request.body)
    if (memoryTurn?.unit)
      units.push(memoryTurn.unit)
    const watch = this.watch?.unit()
    if (watch)
      units.push(watch)
    const awareness = this.perception && awarenessUnit(this.perception.current(), this.now())
    if (awareness)
      units.push(awareness)
    return {
      units,
      finish: (outcome) => {
        directorTurn?.finish(outcome)
        memoryTurn?.finish(outcome)
      },
    }
  }

  async close(): Promise<void> {
    if (this.closed)
      return
    this.closed = true
    await this.director?.close()
    await this.watch?.shutdown()
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
