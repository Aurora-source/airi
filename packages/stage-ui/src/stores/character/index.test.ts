import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isProxy, ref } from 'vue'

import { setCharacterLlmMarkerParserFactoryForTest, useCharacterStore } from '.'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ locale: ref('en'), t: (key: string) => key, te: () => true }),
}))

/** A proxied client posts proxied request data, which a BroadcastChannel cannot clone. This fake reports that case. */
vi.mock('../../services/speech/speech-client', () => ({
  SpeechClient: class {
    write() {
      return Promise.resolve({ status: 'accepted' })
    }

    special() {
      return Promise.resolve({ status: 'accepted' })
    }

    end() {
      return Promise.resolve({ status: isProxy(this) ? 'failed' : 'accepted' })
    }

    finish() {
      return Promise.resolve({ status: isProxy(this) ? 'failed' : 'finished' })
    }

    cancel() {
      return Promise.resolve({ status: 'cancelled' })
    }
  },
}))

describe('character store notification speech', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setCharacterLlmMarkerParserFactoryForTest(((options: { onLiteral: (literal: string) => Promise<void> }) => ({
      consume: async (text: string) => options.onLiteral(text),
      end: async () => {},
    })) as unknown as Parameters<typeof setCharacterLlmMarkerParserFactoryForTest>[0])
  })

  afterEach(() => {
    setCharacterLlmMarkerParserFactoryForTest(null)
  })

  it('finishes a spoken reaction with the raw speech client and reports finished', async () => {
    const store = useCharacterStore()
    store.onSparkNotifyReactionStreamEvent('notify-1', 'What a scene.')
    store.onSparkNotifyReactionStreamEnd('notify-1', 'What a scene.')
    expect(await store.waitForSparkNotifyReactionSpeech('notify-1')).toBe('finished')
  })

  it('keeps a revoked reaction silent and reports no speech', async () => {
    const store = useCharacterStore()
    store.cancelSparkNotifyReaction('notify-2', 'revoked')
    store.onSparkNotifyReactionStreamEvent('notify-2', 'Too late.')
    store.onSparkNotifyReactionStreamEnd('notify-2', 'Too late.')
    expect(store.isSparkNotifyReactionRevoked('notify-2')).toBe(true)
    expect(await store.waitForSparkNotifyReactionSpeech('notify-2')).toBe('none')
  })
})
