import type { InputVoiceActivityEvent } from '@proj-airi/server-sdk'

import { VoiceController } from '@proj-airi/core-agent'
import { AudioInput, createPushStream } from '@proj-airi/pipelines-audio'
import { expect, it, vi } from 'vitest'

import { announceVoiceActivity } from './voice-activity-announcer'

it('reports the start and the settlement of each speech input once', async () => {
  const source = createPushStream<never>()
  const controller = new VoiceController({ audio: new AudioInput({ live: true, open: () => source.stream }), transcriber: () => ({ transcribe: vi.fn() }), submit: vi.fn() })
  const reported: InputVoiceActivityEvent[] = []
  const stop = announceVoiceActivity(controller, activity => void reported.push(activity))

  const first = controller.beginInput({ sessionId: 'alice', interruptTurns: [], start: { kind: 'after-silence' } })
  expect(reported).toEqual([{ active: true, inputId: first.id }])
  first.cancel('User released the button')
  await first.done
  expect(reported).toEqual([{ active: true, inputId: first.id }, { active: false, inputId: first.id }])

  stop()
  const second = controller.beginInput({ sessionId: 'alice', interruptTurns: [], start: { kind: 'after-silence' } })
  second.cancel('Stopped')
  await second.done
  expect(reported).toHaveLength(2)
  await controller.close()
})
