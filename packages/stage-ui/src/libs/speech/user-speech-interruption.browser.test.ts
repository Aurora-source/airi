import type { IntentHandle } from '@proj-airi/pipelines-audio'

import { createPlaybackManager, createSpeechPipeline } from '@proj-airi/pipelines-audio'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { watch } from 'vue'

import { useSpeechOutputControlStore } from '../../stores/speech-output-control'
import { useVoiceInputPolicyStore } from '../../stores/voice-input-policy'
import { bindSpeakingStateToPlaybackManager } from './playback-speaking-state'

describe('detected user speech with browser playback', () => {
  it('stops active and pending chunks, ignores late audio, and allows repeated interruptions and the next response', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const context = new AudioContext()
    const startAudio = document.createElement('button')
    startAudio.textContent = 'Start test audio'
    startAudio.addEventListener('click', () => {
      void context.resume()
    })
    document.body.append(startAudio)
    await page.getByRole('button', { name: 'Start test audio' }).click()
    await expect.poll(() => context.state).toBe('running')
    const control = useSpeechOutputControlStore()
    let currentIntent: IntentHandle | undefined
    let speaking = false
    let detectedAt = 0
    const stopCallMs: number[] = []
    const sourceEndedMs: number[] = []
    const started: string[] = []
    const interrupted: string[] = []
    const turns: string[] = []
    const signals: AbortSignal[] = []
    let finishLateAudio: (() => void) | undefined
    const playback = createPlaybackManager<AudioBuffer>({
      maxVoices: 1,
      overflowPolicy: 'queue',
      play: async (item, signal) => {
        const source = context.createBufferSource()
        source.buffer = item.audio
        source.connect(context.destination)
        await new Promise<void>((resolve) => {
          let interruptedSource = false
          const stop = () => {
            interruptedSource = true
            source.stop()
            source.disconnect()
            stopCallMs.push(performance.now() - detectedAt)
          }
          source.onended = () => {
            signal.removeEventListener('abort', stop)
            if (interruptedSource)
              sourceEndedMs.push(performance.now() - detectedAt)
            source.disconnect()
            resolve()
          }
          signal.addEventListener('abort', stop, { once: true })
          source.start()
          started.push(item.turnId!)
        })
      },
    })
    bindSpeakingStateToPlaybackManager(playback, { setSpeaking: value => speaking = value })
    playback.onInterrupt(({ item }) => interrupted.push(item.turnId!))
    const pipeline = createSpeechPipeline<AudioBuffer>({
      playback,
      tts: async (request, signal) => {
        signals.push(signal)
        if (request.turnId === 'first' && request.sequence === 1)
          await new Promise<void>(resolve => finishLateAudio = resolve)
        return context.createBuffer(1, context.sampleRate, context.sampleRate)
      },
    })
    pipeline.on('onTurnStart', turnId => turns.push(turnId))
    const stopWatching = watch(() => control.latestStopRequest, (request) => {
      if (!request || (!currentIntent && !speaking))
        return
      currentIntent?.cancel(request.reason)
      currentIntent = undefined
      pipeline.stopAll(request.reason)
      playback.stopAll(request.reason)
    }, { flush: 'sync' })
    const startResponse = (turnId: string) => {
      currentIntent = pipeline.openIntent({ turnId })
      currentIntent.writeLiteral('The first sentence contains enough words. The second sentence contains more words. The third sentence contains enough words.')
      currentIntent.end()
    }
    const detectUserSpeech = () => {
      if (currentIntent || speaking)
        detectedAt = performance.now()
      control.requestStopSpeaking('user-speech')
    }

    try {
      detectUserSpeech()
      expect(interrupted).toEqual([])
      startResponse('first')
      await vi.waitFor(() => expect(started).toEqual(['first']))
      await vi.waitFor(() => expect(finishLateAudio).toBeDefined())
      await vi.waitFor(() => expect(signals).toHaveLength(3))
      detectUserSpeech()
      detectUserSpeech()
      expect(speaking).toBe(false)
      expect(interrupted).toEqual(['first'])
      expect(signals.every(signal => signal.aborted)).toBe(true)
      finishLateAudio?.()
      await vi.waitFor(() => expect(sourceEndedMs).toHaveLength(1))
      expect(started).toEqual(['first'])

      await new Promise(resolve => setTimeout(resolve, 500))
      for (const turnId of ['second', 'third']) {
        startResponse(turnId)
        await vi.waitFor(() => expect(started.at(-1)).toBe(turnId))
        detectUserSpeech()
        expect(speaking).toBe(false)
        await vi.waitFor(() => expect(sourceEndedMs).toHaveLength(turns.length))
      }
      expect(interrupted).toEqual(['first', 'second', 'third'])
      expect(turns).toEqual(['first', 'second', 'third'])
      expect(started).toEqual(['first', 'second', 'third'])
      expect(stopCallMs).toHaveLength(3)
      expect(Math.max(...stopCallMs)).toBeLessThan(100)
      console.info('[Barge-in browser measurement]', JSON.stringify({ detectedToSourceStopCallMs: stopCallMs, detectedToSourceEndedMs: sourceEndedMs }))
    }
    finally {
      finishLateAudio?.()
      stopWatching()
      pipeline.stopAll('test-cleanup')
      playback.stopAll('test-cleanup')
      await context.close()
      startAudio.remove()
      disposePinia(pinia)
      localStorage.clear()
    }
  })

  it('keeps headphone continuous input and explicit activation policies distinct', () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    try {
      const policy = useVoiceInputPolicyStore()
      expect(policy.automaticListeningEnabled).toBe(true)
      expect(policy.bargeInEnabled).toBe(true)
      policy.outputDevice = 'speakers'
      expect(policy.automaticListeningEnabled).toBe(true)
      expect(policy.bargeInEnabled).toBe(false)
      policy.mode = 'wake-word'
      expect(policy.automaticListeningEnabled).toBe(false)
      policy.mode = 'push-to-talk'
      expect(policy.automaticListeningEnabled).toBe(false)
    }
    finally {
      disposePinia(pinia)
      localStorage.clear()
    }
  })
})
