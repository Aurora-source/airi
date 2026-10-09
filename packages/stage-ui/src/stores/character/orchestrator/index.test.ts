import type { Conversation } from '@proj-airi/core-agent'
import type { WebSocketEventOf } from '@proj-airi/server-sdk'
/* eslint-disable style/indent-binary-ops */
/* eslint-disable style/operator-linebreak */
import type { Pinia, Store, StoreDefinition } from 'pinia'
import type { Mock } from 'vitest'
import type { UnwrapRef } from 'vue'
import type z from 'zod'

import type { StreamEvent } from '../../ai/chat-llm/llm'
import type { AiriCard } from '../../modules'

import { renderConversationPreview } from '@proj-airi/core-agent'
import { tool } from '@xsai/tool'
import { nanoid } from 'nanoid'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

import { sparkNotifyCommandSchema, useCharacterOrchestratorStore } from '.'
import { useCharacterStore } from '..'
import { useLLM } from '../../ai/chat-llm/llm'
import { useModsServerChannelStore } from '../../mods/api/channel-server'
import { useAiriCardStore, useConsciousnessStore } from '../../modules'
import { useProviderStore } from '../../providers/provider'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    locale: ref('en'),
    t: (key: string) => key,
    te: () => true,
  }),
}))

function mockedStore<TStoreDef extends (pinia?: Pinia) => unknown>(
  useStore: TStoreDef,
  pinia?: Pinia,
): TStoreDef extends StoreDefinition<
  infer Id,
  infer State,
  infer Getters,
  infer Actions
>
  ? Store<
    Id,
    State,
    Record<string, never>,
    {
      [K in keyof Actions]: Actions[K] extends (...args: any[]) => any
        ? // 👇 depends on your testing framework
        Mock<Actions[K]>
        : Actions[K]
    }
  > & {
    [K in keyof Getters]: UnwrapRef<Getters[K]>
  }
  : ReturnType<TStoreDef> {
  return useStore(pinia) as any
}

function getObjectSchema(schema?: Record<string, any>) {
  if (!schema)
    return undefined

  if (schema.type === 'object')
    return schema

  const candidates = [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]
  return candidates.find((candidate: Record<string, any>) => candidate?.type === 'object')
}

function getArraySchema(schema?: Record<string, any>) {
  if (!schema)
    return undefined

  if (schema.type === 'array')
    return schema

  const candidates = [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]
  return candidates.find((candidate: Record<string, any>) => candidate?.type === 'array')
}

describe('sparkNotifyCommandSchema', () => {
  it('emits strict objects in the json schema', async () => {
    const sparkTool = await tool({
      name: 'builtIn_sparkCommand',
      description: 'test',
      parameters: sparkNotifyCommandSchema,
      execute: async () => undefined,
    })

    const schema = sparkTool.function.parameters as Record<string, any>
    const commandsSchema = getArraySchema(schema.properties?.commands)
    const commandItemSchema = getObjectSchema(commandsSchema?.items)
    const guidanceSchema = getObjectSchema(commandItemSchema?.properties?.guidance)
    const personaSchema = getArraySchema(guidanceSchema?.properties?.persona)
    const personaItemSchema = getObjectSchema(personaSchema?.items)
    const optionsSchema = getArraySchema(guidanceSchema?.properties?.options)
    const optionsItemSchema = getObjectSchema(optionsSchema?.items)

    expect(schema.additionalProperties).toBe(false)
    expect(commandItemSchema?.additionalProperties).toBe(false)
    expect(guidanceSchema?.additionalProperties).toBe(false)
    expect(personaItemSchema?.additionalProperties).toBe(false)
    expect(optionsItemSchema?.additionalProperties).toBe(false)
  })
})

describe('store character-orchestrator', () => {
  const sendSparkCommandMock = vi.fn()
  let pinia: ReturnType<typeof createPinia>

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)

    sendSparkCommandMock.mockReset()
    mockedStore(useModsServerChannelStore, pinia).send = sendSparkCommandMock

    const mockGetChatProviderInstance = vi.fn()
    mockedStore(useProviderStore, pinia).getChatProviderInstance = mockGetChatProviderInstance
    mockedStore(useProviderStore, pinia).getChatProviderInstance.mockResolvedValue({ generation: (model: string) => ({ protocol: 'chat-completions', config: { model, apiKey: 'test', baseURL: 'https://example.com/v1/' } }) })

    const consciousnessStore = useConsciousnessStore(pinia)
    consciousnessStore.activeProvider = 'mock-provider'
    consciousnessStore.activeModel = 'mock-model'

    const airiCardStore = useAiriCardStore(pinia)
    // @ts-expect-error - testing purpose
    airiCardStore.systemPrompt = 'You are a brave adventurer in Minecraft.'
    // @ts-expect-error - testing purpose
    airiCardStore.activeCard = {
      name: 'Hero',
      version: '1.0',
      extensions: {
        airi: {
          agents: {},
          modules: {
            consciousness: {
              provider: 'mock-provider',
              model: 'mock-model',
            },
            vision: {
              provider: 'mock-vision-provider',
              model: 'mock-vision-model',
            },
            speech: {
              provider: 'mock-speech-provider',
              model: 'mock-speech-model',
              voice_id: 'alloy',
            },
          },
        },
      },
    } satisfies AiriCard
  })

  it('handles immediate spark:notify with reaction and commands', async () => {
    const mockStream = vi.fn()
    mockedStore(useLLM, pinia).stream = mockStream
    mockedStore(useLLM, pinia).stream.mockImplementation(async (_model: string, _provider: unknown, _messages: unknown, options: any) => {
      if (options?.tools?.length) {
        await options.tools[1].execute({ commands: [{
          destinations: ['minecraft'],
          intent: 'action',
          priority: 'critical',
          interrupt: 'false',
          ack: 'ok',
          guidance: null,
        }] } satisfies z.infer<typeof sparkNotifyCommandSchema>)
      }

      await options?.onStreamEvent?.({ type: 'text-delta', text: 'Ahhh, got hit by zombie!' } satisfies StreamEvent)
      await options?.onStreamEvent?.({ type: 'finish' } satisfies StreamEvent)
    })

    const mockOnSparkNotifyReactionStreamEvent = vi.fn()
    mockedStore(useCharacterStore, pinia).onSparkNotifyReactionStreamEvent = mockOnSparkNotifyReactionStreamEvent
    const mockOnSparkNotifyReactionStreamEnd = vi.fn()
    mockedStore(useCharacterStore, pinia).onSparkNotifyReactionStreamEnd = mockOnSparkNotifyReactionStreamEnd

    const store = useCharacterOrchestratorStore(pinia)
    const event: WebSocketEventOf<'spark:notify'> = {
      type: 'spark:notify',
      source: 'minecraft',
      data: {
        id: nanoid(),
        eventId: nanoid(),
        kind: 'alarm',
        urgency: 'immediate',
        headline: 'Hit by zombie',
        destinations: ['character'],
      },
    }

    const result = await store.handleSparkNotify(event)

    expect(result?.commands).toHaveLength(1)
    expect(result?.commands?.[0].destinations).toEqual([event.source])
    expect(result?.commands?.[0].parentEventId).toBe(event.data.id)
    expect(result?.commands?.[0].intent).toBe('action')
    expect(result?.commands?.[0].priority).toBe('critical')

    expect(mockStream).toHaveBeenCalledTimes(1)
    expect(mockStream.mock.calls).toHaveLength(1)
    expect(mockStream.mock.calls[0][0]).toEqual('mock-model')
    expect(mockStream.mock.calls[0][1]).not.toBeNull()
    expect((mockStream.mock.calls[0][2] as Conversation).turns).toHaveLength(2)
    expect(mockStream.mock.calls[0][3]).toHaveProperty('tools')

    expect(mockOnSparkNotifyReactionStreamEvent).toHaveBeenCalledWith(event.data.id, 'Ahhh, got hit by zombie!')
    expect(mockOnSparkNotifyReactionStreamEnd).toHaveBeenCalledTimes(1)
  })

  it('supports forcing text-only spark:notify responses', async () => {
    const mockStream = vi.fn()
    mockedStore(useLLM, pinia).stream = mockStream
    mockedStore(useLLM, pinia).stream.mockImplementation(async (_model: string, _provider: unknown, _messages: unknown, options: any) => {
      await options?.onStreamEvent?.({ type: 'text-delta', text: 'I choose d5 to pressure the center.' } satisfies StreamEvent)
      await options?.onStreamEvent?.({ type: 'finish' } satisfies StreamEvent)
    })

    const onDelta = vi.fn()
    const onEnd = vi.fn()
    mockedStore(useCharacterStore, pinia).onSparkNotifyReactionStreamEvent = onDelta
    mockedStore(useCharacterStore, pinia).onSparkNotifyReactionStreamEnd = onEnd

    const store = useCharacterOrchestratorStore(pinia)
    const event: WebSocketEventOf<'spark:notify'> = {
      type: 'spark:notify',
      source: 'plugin:airi-plugin-game-chess',
      data: {
        id: nanoid(),
        eventId: nanoid(),
        kind: 'ping',
        urgency: 'immediate',
        headline: 'AIRI played d5',
        destinations: ['character'],
      },
    }

    await store.handleSparkNotifyWithReaction(event, {
      forceTextResponse: true,
    })

    const streamOptions = mockStream.mock.lastCall?.[3]
    expect(streamOptions).toMatchObject({
      supportsTools: false,
      tools: [],
      waitForTools: false,
    })
    expect(streamOptions?.toolChoice).toBeUndefined()
    expect(onDelta).toHaveBeenCalled()
    expect(onEnd).toHaveBeenCalled()
  })

  it('supports forcing spark-command responses', async () => {
    const mockStream = vi.fn()
    mockedStore(useLLM, pinia).stream = mockStream
    mockedStore(useLLM, pinia).stream.mockImplementation(async (_model: string, _provider: unknown, _messages: unknown, options: any) => {
      const sparkCommandTool = options?.tools?.find((tool: any) => tool.function?.name === 'builtIn_sparkCommand')
      await sparkCommandTool.execute({
        commands: [{
          destinations: ['minecraft'],
          intent: 'action',
          priority: 'high',
          interrupt: 'false',
          ack: 'go',
          guidance: null,
        }],
      } satisfies z.infer<typeof sparkNotifyCommandSchema>)
      await options?.onStreamEvent?.({ type: 'text-delta', text: 'This should be ignored.' } satisfies StreamEvent)
      await options?.onStreamEvent?.({ type: 'finish' } satisfies StreamEvent)
    })

    const onDelta = vi.fn()
    const onEnd = vi.fn()
    mockedStore(useCharacterStore, pinia).onSparkNotifyReactionStreamEvent = onDelta
    mockedStore(useCharacterStore, pinia).onSparkNotifyReactionStreamEnd = onEnd

    const store = useCharacterOrchestratorStore(pinia)
    const event: WebSocketEventOf<'spark:notify'> = {
      type: 'spark:notify',
      source: 'minecraft',
      data: {
        id: nanoid(),
        eventId: nanoid(),
        kind: 'alarm',
        urgency: 'immediate',
        headline: 'Take cover',
        destinations: ['character'],
      },
    }

    const result = await store.handleSparkNotify(event, {
      forceSparkCommandResponse: true,
    })

    const streamOptions = mockStream.mock.lastCall?.[3]
    expect(streamOptions).toMatchObject({
      supportsTools: true,
      toolChoice: {
        type: 'function',
        function: { name: 'builtIn_sparkCommand' },
      },
      waitForTools: true,
    })
    expect(result?.commands?.length).toBe(1)
    expect(sendSparkCommandMock).toHaveBeenCalledWith({
      type: 'spark:command',
      data: result?.commands[0],
    })
    expect(onDelta).not.toHaveBeenCalled()
    expect(onEnd).toHaveBeenCalledWith(event.data.id, '')
  })

  // https://github.com/moeru-ai/airi/pull/2464#discussion_r3933609456
  it('preserves runtime rules when a Spark caller replaces the user payload', async () => {
    const mockStream = vi.fn()
    mockedStore(useLLM, pinia).stream = mockStream
    mockedStore(useLLM, pinia).stream.mockImplementation(async (_model: string, _provider: unknown, _messages: unknown, options: any) => {
      await options?.onStreamEvent?.({ type: 'text-delta', text: 'legacy-safe text' } satisfies StreamEvent)
      await options?.onStreamEvent?.({ type: 'finish' } satisfies StreamEvent)
    })

    const store = useCharacterOrchestratorStore(pinia)
    const event: WebSocketEventOf<'spark:notify'> = {
      type: 'spark:notify',
      source: 'plugin:airi-plugin-game-chess',
      data: {
        id: nanoid(),
        eventId: nanoid(),
        kind: 'ping',
        urgency: 'immediate',
        headline: 'Legacy rendering',
        destinations: ['character'],
      },
    }

    await store.handleSparkNotify(event, {
      forceTextResponse: true,
      messageOverride: {
        appendSystemInstructions: ['Plugin-specific hint'],
        appendUserSections: ['Rendered board snapshot'],
        replaceUserMessage: 'Replacement user payload',
      },
    })

    const context = mockStream.mock.lastCall?.[2] as Conversation | undefined
    const renderedMessages = context ? renderConversationPreview(context).map(message => message.content) : undefined
    expect(String(renderedMessages?.[0])).toContain('Plugin-specific hint')
    expect(String(renderedMessages?.[1])).toContain('Replacement user payload')
    expect(String(renderedMessages?.[1])).toContain('Rendered board snapshot')
    expect(String(renderedMessages?.[1])).toContain('base.prompt.emotion')
    expect(String(renderedMessages?.[1])).toContain('base.prompt.emoji')
  })

  it('drops a queued spark:notify whose ttlMs passed before it could run, and runs one without a lifetime', async () => {
    vi.useFakeTimers()
    try {
      const mockStream = vi.fn(async () => {})
      mockedStore(useLLM, pinia).stream = mockStream
      const store = useCharacterOrchestratorStore(pinia)
      const notify = (ttlMs?: number): WebSocketEventOf<'spark:notify'> => ({
        type: 'spark:notify',
        source: 'companion-core-watch',
        data: { id: nanoid(), eventId: nanoid(), kind: 'ping', urgency: 'immediate', headline: 'Watch moment', destinations: ['character'], ttlMs },
      })

      // Busy with another reaction, so both notifications wait in the queue.
      store.processing = true
      await store.handleSparkNotify(notify(3000))
      await store.handleSparkNotify(notify())
      expect(store.scheduledNotifies).toHaveLength(2)
      store.processing = false

      vi.advanceTimersByTime(4000)
      store.startTicker()
      await vi.advanceTimersByTimeAsync(4000)
      store.stopTicker()

      expect(store.scheduledNotifies).toHaveLength(0)
      expect(mockStream).toHaveBeenCalledTimes(1)
    }
    finally {
      vi.useRealTimers()
    }
  })

  function ackNotify(overrides: Partial<WebSocketEventOf<'spark:notify'>['data']> = {}): WebSocketEventOf<'spark:notify'> {
    return {
      type: 'spark:notify',
      source: 'companion-core-director',
      data: { id: nanoid(), eventId: nanoid(), kind: 'ping', urgency: 'immediate', headline: 'Watch moment', destinations: ['character'], requiresAck: true, ttlMs: 5000, ...overrides },
      metadata: { source: { kind: 'plugin', id: 'director-instance-1', plugin: { id: 'companion-core-director' } } },
    }
  }

  function acks() {
    return sendSparkCommandMock.mock.calls.map(([event]) => event).filter(event => event.type === 'spark:emit').map(event => event.data.state)
  }

  it('acknowledges a requested notify as done only after its spoken reaction finished', async () => {
    mockedStore(useLLM, pinia).stream = vi.fn(async (_model: string, _provider: unknown, _messages: unknown, options: any) => {
      await options?.onStreamEvent?.({ type: 'text-delta', text: 'What a scene.' } satisfies StreamEvent)
      await options?.onStreamEvent?.({ type: 'finish' } satisfies StreamEvent)
    })
    const character = mockedStore(useCharacterStore, pinia)
    character.onSparkNotifyReactionStreamEvent = vi.fn()
    character.onSparkNotifyReactionStreamEnd = vi.fn()
    let finishSpeech: (status: 'finished' | 'interrupted') => void = () => {}
    character.waitForSparkNotifyReactionSpeech = vi.fn(() => new Promise(resolve => finishSpeech = resolve))
    const store = useCharacterOrchestratorStore(pinia)
    const event = ackNotify()
    character.reactions.push({ id: 'reaction-1', message: 'What a scene.', createdAt: Date.now(), sourceEventId: event.data.id })

    await store.handleSparkNotify(event)
    expect(acks()).toEqual(['working'])
    finishSpeech('finished')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(acks()).toEqual(['working', 'done'])
    // The server delivers an empty destination list to nobody, so every acknowledgement names its producer.
    const emits = sendSparkCommandMock.mock.calls.map(([sent]) => sent).filter(sent => sent.type === 'spark:emit')
    expect(emits.every(sent => sent.route?.destinations?.[0] === 'instance:director-instance-1')).toBe(true)
  })

  it('reports dropped when the reaction speech was interrupted or no reaction came', async () => {
    mockedStore(useLLM, pinia).stream = vi.fn(async () => {})
    const character = mockedStore(useCharacterStore, pinia)
    character.waitForSparkNotifyReactionSpeech = vi.fn(async () => 'interrupted' as const)
    const store = useCharacterOrchestratorStore(pinia)

    await store.handleSparkNotify(ackNotify())
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(acks()).toEqual(['working', 'dropped'])

    const spoken = ackNotify()
    character.reactions.push({ id: 'reaction-2', message: 'Oh!', createdAt: Date.now(), sourceEventId: spoken.data.id })
    await store.handleSparkNotify(spoken)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(acks()).toEqual(['working', 'dropped', 'working', 'dropped'])
  })

  it('removes a queued notify that its producer revoked, stops its speech, and expires late ones', async () => {
    vi.useFakeTimers()
    try {
      const mockStream = vi.fn(async () => {})
      mockedStore(useLLM, pinia).stream = mockStream
      const character = mockedStore(useCharacterStore, pinia)
      character.cancelSparkNotifyReaction = vi.fn()
      const store = useCharacterOrchestratorStore(pinia)
      store.processing = true
      const revoked = ackNotify()
      const late = ackNotify({ ttlMs: 1000 })
      await store.handleSparkNotify(revoked)
      await store.handleSparkNotify(late)
      expect(store.scheduledNotifies).toHaveLength(2)

      await store.handleSparkEmit({ type: 'spark:emit', data: { id: revoked.data.id, state: 'dropped', destinations: [] }, metadata: { source: { kind: 'plugin', id: 'companion-core-director', plugin: { id: 'companion-core-director' } }, event: { id: nanoid() } } })
      expect(store.scheduledNotifies).toHaveLength(1)
      expect(character.cancelSparkNotifyReaction).toHaveBeenCalledWith(revoked.data.id, 'Revoked by its producer')

      store.processing = false
      vi.advanceTimersByTime(2000)
      store.startTicker()
      await vi.advanceTimersByTimeAsync(2500)
      store.stopTicker()
      expect(store.scheduledNotifies).toHaveLength(0)
      expect(mockStream).not.toHaveBeenCalled()
      expect(acks()).toEqual(['expired'])
    }
    finally {
      vi.useRealTimers()
    }
  })
})
