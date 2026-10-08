import type { WebSocketEventOptionalSource } from '@proj-airi/server-sdk'

import { FakeChannel } from './watch'

type VisualRequest = Extract<WebSocketEventOptionalSource, { type: 'output:visual:request' }>['data']
type SparkNotify = Extract<WebSocketEventOptionalSource, { type: 'spark:notify' }>['data']

/**
 * Plays the AIRI stage for the Core's Director client: the visual behavior host, speech ownership reports, and Spark
 * acknowledgements. Tests choose the visual admission result and acknowledge Spark speech themselves.
 *
 * @example
 * const stage = new FakeStage()
 * new CompanionDirector({ config, createClient: stage.channel.connect })
 * stage.ready()
 */
export class FakeStage {
  readonly channel = new FakeChannel()
  /** Admission result that the visual host answers. `none` answers nothing. */
  visualResult: 'started' | 'blocked' | 'cooldown' | 'none' = 'started'
  readonly visuals: VisualRequest[] = []
  readonly cancels: string[] = []
  readonly notifies: SparkNotify[] = []
  readonly drops: string[] = []

  constructor() {
    const send = this.channel.send.bind(this.channel)
    this.channel.send = (event) => {
      const sent = send(event)
      if (event.type === 'output:visual:request') {
        this.visuals.push(event.data)
        if (event.data.behavior && this.visualResult !== 'none') {
          const result = this.visualResult
          queueMicrotask(() => this.channel.emit('output:visual:result', { requestId: event.data.requestId, result }))
        }
      }
      else if (event.type === 'output:visual:cancel') {
        this.cancels.push(event.data.requestId)
      }
      else if (event.type === 'spark:notify') {
        this.notifies.push(event.data)
      }
      else if (event.type === 'spark:emit') {
        this.drops.push(event.data.id)
      }
      return sent
    }
  }

  /** Connects and reports a loaded model with a visual controller. */
  ready(visual: { available?: boolean, blocked?: boolean } = {}): void {
    this.channel.ready(true)
    this.channel.emit('output:visual:state', { available: visual.available ?? true, blocked: visual.blocked ?? false })
  }

  /** Behavior requests, without base activity requests. */
  behaviors(): string[] {
    return this.visuals.flatMap(request => request.behavior ? [request.behavior] : [])
  }

  /** The stage reports speech ownership of one response turn. */
  speak(turnId: string, active: boolean, sessionId?: string): void {
    this.channel.emit('output:voice:activity', { active, outputId: turnId, sessionId })
  }

  /** The stage acknowledges one Spark notify. */
  ack(id: string, state: 'working' | 'done' | 'dropped' | 'expired' | 'blocked'): void {
    this.channel.emit('spark:emit', { id, eventId: id, state, destinations: ['proj-airi:companion-core-director'] })
  }
}
