import type { SpeechClient } from '../../services/speech/speech-client'

import { nanoid } from 'nanoid'
import { defineStore, storeToRefs } from 'pinia'
import { computed, reactive, ref } from 'vue'

import { useLlmmarkerParser } from '../../composables/llm-marker-parser'
import { SpeechClient as Speech } from '../../services/speech/speech-client'
import { useChatSessionStore } from '../chat/session-store'
import { useAiriCardStore } from '../modules'

export * from './notebook'
export * from './orchestrator'

export interface CharacterSparkNotifyReaction {
  id: string
  message: string
  createdAt: number
  sourceEventId?: string
  metadata?: Record<string, unknown>
}

interface StreamingReactionState {
  reaction: CharacterSparkNotifyReaction
  speech: SpeechClient
  parser: ReturnType<ParserFactory>
}

const MAX_REACTIONS = 200
/** Completion records and revoked ids kept for acknowledgements. Older ones leave first. */
const MAX_REACTION_RECORDS = 32

/** How the speech of one reaction ended, from its speech host. `none` means the reaction had no speech. */
export type SparkNotifyReactionSpeechStatus = 'finished' | 'cancelled' | 'interrupted' | 'failed' | 'closed' | 'accepted' | 'none'

function remember<K, V>(map: Map<K, V>, key: K, value: V) {
  map.set(key, value)
  if (map.size > MAX_REACTION_RECORDS)
    map.delete(map.keys().next().value!)
}
type ParserFactory = typeof useLlmmarkerParser
let parserFactory: ParserFactory = useLlmmarkerParser

export function setCharacterLlmMarkerParserFactoryForTest(factory: ParserFactory | null) {
  parserFactory = factory ?? useLlmmarkerParser
}

export const useCharacterStore = defineStore('character', () => {
  const { activeCard, systemPrompt } = storeToRefs(useAiriCardStore())

  const name = computed(() => activeCard.value?.name ?? '')

  const reactions = ref<CharacterSparkNotifyReaction[]>([])
  const streamingReactions = ref<Map<string, StreamingReactionState>>(new Map())
  const reactionSpeech = new Map<string, Promise<SparkNotifyReactionSpeechStatus>>()
  const revokedReactions = new Map<string, true>()
  const sessions = useChatSessionStore()

  async function emitTextOutput(text: string) {
    const speech = new Speech({ sessionId: sessions.activeSessionId, turnId: nanoid() }, 'read-aloud')

    const parser = parserFactory({
      onLiteral: async (literal) => {
        if (literal)
          await speech.write(literal)
      },
      onSpecial: async (special) => {
        if (special)
          await speech.special(special)
      },
    })

    await parser.consume(text)
    await parser.end()

    await speech.end()
    void speech.finish().catch(error => console.error('Speech output failed', error))
  }

  function onSparkNotifyReactionStreamEvent(sparkEventId: string, chunk: string, options?: { metadata?: Record<string, unknown> }) {
    if (revokedReactions.has(sparkEventId))
      return

    if (!streamingReactions.value.has(sparkEventId)) {
      const newReaction = reactive({
        id: nanoid(),
        message: '',
        createdAt: Date.now(),
        sourceEventId: sparkEventId,
        metadata: options?.metadata,
      }) satisfies CharacterSparkNotifyReaction

      const speech = new Speech({ sessionId: sessions.activeSessionId, turnId: `spark:${sparkEventId}` }, 'notification')

      const parser = parserFactory({
        onLiteral: async (literal) => {
          if (literal)
            await speech.write(literal)
        },
        onSpecial: async (special) => {
          if (special)
            await speech.special(special)
        },
      })

      streamingReactions.value.set(sparkEventId, { reaction: newReaction, speech, parser })
    }

    const state = streamingReactions.value.get(sparkEventId)!
    state.reaction.message += chunk
    void state.parser.consume(chunk)
  }

  function onSparkNotifyReactionStreamEnd(sparkEventId: string, fullText: string, options?: { metadata?: Record<string, unknown> }) {
    const state = streamingReactions.value.get(sparkEventId)
    if (!state || revokedReactions.has(sparkEventId))
      return

    state.reaction.message = fullText
    recordSparkNotifyReaction(sparkEventId, fullText, { metadata: options?.metadata })

    const done = state.parser.end().then(async () => {
      await state.speech.end()
      streamingReactions.value.delete(sparkEventId)
      return (await state.speech.finish()).status
    }).catch((error): SparkNotifyReactionSpeechStatus => {
      console.error('Notification speech failed', error)
      return 'failed'
    })
    remember(reactionSpeech, sparkEventId, done)
  }

  /** How the speech of one reaction ended. A reaction without speech resolves `none`. */
  function waitForSparkNotifyReactionSpeech(sparkEventId: string): Promise<SparkNotifyReactionSpeechStatus> {
    return reactionSpeech.get(sparkEventId) ?? Promise.resolve('none')
  }

  /** Stops one reaction that its producer revoked. Later stream chunks of that reaction stay silent. */
  function cancelSparkNotifyReaction(sparkEventId: string, reason: string) {
    remember(revokedReactions, sparkEventId, true)
    const state = streamingReactions.value.get(sparkEventId)
    if (!state)
      return
    streamingReactions.value.delete(sparkEventId)
    void state.speech.cancel(reason).catch(error => console.error('Notification speech cancel failed', error))
  }

  function isSparkNotifyReactionRevoked(sparkEventId: string) {
    return revokedReactions.has(sparkEventId)
  }

  function recordSparkNotifyReaction(sparkEventId: string, message: string, options?: { metadata?: Record<string, unknown> }) {
    const newReaction = {
      id: nanoid(),
      message,
      createdAt: Date.now(),
      sourceEventId: sparkEventId,
      metadata: options?.metadata,
    } satisfies CharacterSparkNotifyReaction

    reactions.value.push(newReaction)

    if (reactions.value.length > MAX_REACTIONS) {
      reactions.value.splice(0, reactions.value.length - MAX_REACTIONS)
    }
  }

  function clearReactions() {
    reactions.value = []
  }

  return {
    name,
    reactions,
    systemPrompt,

    recordSparkNotifyReaction,
    onSparkNotifyReactionStreamEvent,
    onSparkNotifyReactionStreamEnd,
    waitForSparkNotifyReactionSpeech,
    cancelSparkNotifyReaction,
    isSparkNotifyReactionRevoked,
    clearReactions,

    emitTextOutput,
  }
})
