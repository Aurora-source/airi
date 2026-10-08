import type { SparkNotifyResponseControl } from '@proj-airi/core-agent/agents/spark-notify'
import type { WebSocketBaseEvent, WebSocketEventOf, WebSocketEvents } from '@proj-airi/server-sdk'

import { createSparkNotifyAgent, createSparkNotifyReactionPlugin } from '@proj-airi/core-agent/agents/spark-notify'
import { defineStore, storeToRefs } from 'pinia'
import { ref } from 'vue'

import { useCharacterNotebookStore, useCharacterStore } from '../'
import { useAiriRuntimePrompt } from '../../../composables/use-airi-runtime-prompt'
import { useLLM } from '../../ai/chat-llm/llm'
import { useModsServerChannelStore } from '../../mods/api/channel-server'
import { useConsciousnessStore } from '../../modules/consciousness'

export { sparkNotifyCommandSchema } from '@proj-airi/core-agent/agents/spark-notify'

export const useCharacterOrchestratorStore = defineStore('character-orchestrator', () => {
  const { stream } = useLLM()
  const consciousnessStore = useConsciousnessStore()
  const { activeProvider, activeModel } = storeToRefs(consciousnessStore)
  const characterStore = useCharacterStore()
  const notebookStore = useCharacterNotebookStore()
  const { systemPrompt } = storeToRefs(characterStore)
  const runtimePrompt = useAiriRuntimePrompt()
  const modsServerChannelStore = useModsServerChannelStore()

  const processing = ref(false)
  const pendingNotifies = ref<Array<WebSocketEventOf<'spark:notify'>>>([])

  const scheduledNotifies = ref<Array<{
    event: WebSocketEventOf<'spark:notify'>
    control?: SparkNotifyResponseControl
    enqueuedAt: number
    nextRunAt: number
    attempts: number
    maxAttempts: number
    reason?: string
  }>>([])

  const attentionConfig = ref({
    tickIntervalMs: 2_000,
    taskNotifyWindowMs: 60_000,
    requeueDelayMs: 30_000,
    maxAttempts: 3,
  })

  let tickTimer: ReturnType<typeof setInterval> | undefined
  let initialized = false
  const eventUnsubscribes: Array<() => void> = []
  const sparkNotifyAgent = createSparkNotifyAgent({
    runner: {
      run: request => stream(
        request.selectedChat.model,
        request.selectedChat.provider,
        request.conversation,
        {
          tools: request.tools,
          providerId: request.selectedChat.providerId,
          supportsTools: request.policy.supportsTools,
          waitForTools: request.policy.waitForTools,
          toolChoice: request.policy.toolChoice,
          onStreamEvent: request.onStreamEvent,
        },
      ),
    },
    plugins: [
      createSparkNotifyReactionPlugin({
        onDelta: (eventId, text) => characterStore.onSparkNotifyReactionStreamEvent(eventId, text),
        onEnd: (eventId, text) => characterStore.onSparkNotifyReactionStreamEnd(eventId, text),
      }),
    ],
  })

  function computeNextRunAt(event: WebSocketEventOf<'spark:notify'>, attempts: number) {
    const now = Date.now()
    const baseDelay = (() => {
      switch (event.data.urgency) {
        case 'immediate':
          return 0
        case 'soon':
          return 10_000
        case 'later':
          return 60_000
        default:
          return 30_000
      }
    })()

    return now + baseDelay + (attempts * attentionConfig.value.requeueDelayMs)
  }

  /**
   * Reports the state of a notification whose producer asked for an acknowledgement.
   * `done` follows only a finished spoken reaction, so the producer never counts a dropped one as delivered.
   */
  function acknowledge(event: WebSocketEventOf<'spark:notify'>, state: WebSocketEvents['spark:emit']['state'], note?: string) {
    if (!event.data.requiresAck)
      return
    modsServerChannelStore.send({ type: 'spark:emit', data: { id: event.data.id, eventId: event.data.eventId, state, note, destinations: [] } })
  }

  async function acknowledgeReaction(event: WebSocketEventOf<'spark:notify'>) {
    const id = event.data.id
    const reacted = characterStore.reactions.some(item => item.sourceEventId === id && item.message.trim())
    if (!reacted || characterStore.isSparkNotifyReactionRevoked(id)) {
      acknowledge(event, 'dropped', reacted ? 'revoked' : 'no reaction')
      return
    }
    const status = await characterStore.waitForSparkNotifyReactionSpeech(id)
    acknowledge(event, status === 'finished' && !characterStore.isSparkNotifyReactionRevoked(id) ? 'done' : 'dropped', status)
  }

  function removePending(eventId: string) {
    pendingNotifies.value = pendingNotifies.value.filter(item => item.data.id !== eventId)
  }

  function enqueueSparkNotify(
    event: WebSocketEventOf<'spark:notify'>,
    options?: {
      reason?: string
      nextRunAt?: number
      maxAttempts?: number
      control?: SparkNotifyResponseControl
    },
  ) {
    if (!pendingNotifies.value.some(item => item.data.id === event.data.id)) {
      pendingNotifies.value.push(event)
    }

    scheduledNotifies.value.push({
      event,
      control: options?.control,
      enqueuedAt: Date.now(),
      nextRunAt: options?.nextRunAt ?? computeNextRunAt(event, 0),
      attempts: 0,
      maxAttempts: options?.maxAttempts ?? attentionConfig.value.maxAttempts,
      reason: options?.reason,
    })
  }

  async function processSparkNotify(event: WebSocketEventOf<'spark:notify'>, control?: SparkNotifyResponseControl) {
    const providerId = activeProvider.value
    const model = activeModel.value
    if (!providerId || !model) {
      console.warn('Spark notify ignored: missing active provider or model')
      acknowledge(event, 'blocked', 'no chat model')
      return undefined
    }
    if (characterStore.isSparkNotifyReactionRevoked(event.data.id)) {
      acknowledge(event, 'dropped', 'revoked')
      return undefined
    }

    const provider = await consciousnessStore.getChatProviderInstance(providerId)
    processing.value = true
    acknowledge(event, 'working')

    try {
      const result = await sparkNotifyAgent.handle({
        event,
        selectedChat: {
          providerId,
          model,
          provider,
        },
        systemPrompt: systemPrompt.value,
        runtimePrompt: runtimePrompt.value,
        control,
      })
      // Playback continues after generation, so the acknowledgement waits on its own.
      if (event.data.requiresAck)
        void acknowledgeReaction(event)
      if (!result.commands.length)
        return result

      for (const command of result.commands) {
        modsServerChannelStore.send({
          type: 'spark:command',
          data: command,
        })
      }

      return result
    }
    catch (error) {
      acknowledge(event, 'blocked', 'reaction failed')
      throw error
    }
    finally {
      processing.value = false
    }
  }

  async function handleIncomingSparkNotify(event: WebSocketEventOf<'spark:notify'>, control?: SparkNotifyResponseControl) {
    if (event.data.urgency === 'immediate' && !processing.value) {
      return await processSparkNotify(event, control)
    }

    enqueueSparkNotify(event, { reason: 'spark:notify', control })
    return undefined
  }

  async function handleSparkNotifyWithReaction(
    event: WebSocketEventOf<'spark:notify'>,
    options?: SparkNotifyResponseControl & { fallbackText?: string },
  ) {
    await handleIncomingSparkNotify(event, options)

    const reaction = [...characterStore.reactions]
      .reverse()
      .find(item => item.sourceEventId === event.data.id)
      ?.message
      ?.trim()

    return reaction || options?.fallbackText || ''
  }

  function enqueueDueTasks(now: number) {
    const dueTasks = notebookStore.getDueTasks(now, attentionConfig.value.taskNotifyWindowMs)
    if (!dueTasks.length)
      return

    for (const task of dueTasks) {
      const event: WebSocketEventOf<'spark:notify'> = {
        type: 'spark:notify',
        source: 'character:task-scheduler',
        data: {
          id: `task-${task.id}`,
          eventId: task.id,
          kind: 'reminder',
          urgency: task.priority === 'critical' ? 'immediate' : 'soon',
          headline: `Task reminder: ${task.title}`,
          note: task.details,
          destinations: ['character'],
          payload: {
            taskId: task.id,
            dueAt: task.dueAt,
            priority: task.priority,
          },
        },
      }

      enqueueSparkNotify(event, { reason: 'task:due' })
      notebookStore.markTaskNotified(task.id, now + attentionConfig.value.requeueDelayMs)
    }
  }

  async function tick() {
    if (processing.value)
      return

    const now = Date.now()
    enqueueDueTasks(now)

    const nextIndex = scheduledNotifies.value.findIndex(item => item.nextRunAt <= now)
    if (nextIndex < 0)
      return

    const [next] = scheduledNotifies.value.splice(nextIndex, 1)
    removePending(next.event.data.id)

    // A notification with a lifetime expires with the evidence that caused it. A late reaction would talk past it.
    // A missing or non-positive `ttlMs` means no lifetime.
    const ttlMs = next.event.data.ttlMs
    if (typeof ttlMs === 'number' && ttlMs > 0 && now - next.enqueuedAt > ttlMs) {
      acknowledge(next.event, 'expired')
      return
    }

    try {
      await processSparkNotify(next.event, next.control)
    }
    catch (error) {
      // A producer that asked for an acknowledgement owns retries and deadlines, so it gets no second attempt here.
      if (!next.event.data.requiresAck && next.attempts + 1 < next.maxAttempts) {
        scheduledNotifies.value = [...scheduledNotifies.value, {
          ...next,
          attempts: next.attempts + 1,
          nextRunAt: computeNextRunAt(next.event, next.attempts + 1),
        }]
        pendingNotifies.value = [...pendingNotifies.value, next.event]
      }
      else {
        console.warn('Dropped spark:notify after max attempts:', error)
      }
    }
  }

  function startTicker() {
    if (tickTimer)
      return

    tickTimer = setInterval(() => {
      void tick()
    }, attentionConfig.value.tickIntervalMs)
  }

  function stopTicker() {
    if (!tickTimer)
      return

    clearInterval(tickTimer)
    tickTimer = undefined
  }

  /**
   * A producer revoked its own notification with `dropped` or `expired`. The queued notification leaves, and a
   * reaction that already speaks stops. Other states are progress reports and change nothing here.
   */
  async function handleSparkEmit(event: WebSocketBaseEvent<'spark:emit', WebSocketEvents['spark:emit']>) {
    const { id, state } = event.data
    if (state !== 'dropped' && state !== 'expired')
      return undefined

    scheduledNotifies.value = scheduledNotifies.value.filter(item => item.event.data.id !== id)
    removePending(id)
    characterStore.cancelSparkNotifyReaction(id, 'Revoked by its producer')
    return undefined
  }

  function initialize() {
    if (initialized)
      return

    initialized = true

    eventUnsubscribes.push(
      modsServerChannelStore.onEvent('spark:notify', async (event) => {
        try {
          await handleIncomingSparkNotify(event)
        }
        catch (error) {
          console.warn('Failed to handle spark:notify event:', error)
        }
      }),
    )

    eventUnsubscribes.push(
      modsServerChannelStore.onEvent('spark:emit', async (event) => {
        try {
          await handleSparkEmit(event)
        }
        catch (error) {
          console.warn('Failed to handle spark:emit event:', error)
        }
      }),
    )

    startTicker()
  }

  function dispose() {
    stopTicker()

    for (const unsubscribe of eventUnsubscribes) {
      unsubscribe()
    }

    eventUnsubscribes.length = 0
    initialized = false
  }

  return {
    processing,
    pendingNotifies,
    scheduledNotifies,
    attentionConfig,

    initialize,
    startTicker,
    stopTicker,
    dispose,

    handleSparkNotify: handleIncomingSparkNotify,
    handleSparkNotifyWithReaction,
    handleSparkEmit,
  }
})
