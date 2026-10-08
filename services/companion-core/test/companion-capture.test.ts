import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import type { ScreenFrame } from '../src/perception/ports/contracts'

import process from 'node:process'

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { WindowsScreenCaptureBackend } from '../src/companion/windows-capture'
import { OwnedScreenCapture, PrivacyGate } from '../src/perception'
import { validateFrame } from '../src/perception/capture/validation'

const HELPER = fileURLToPath(new URL('./support/fake-capture-helper.mjs', import.meta.url))

interface Step {
  kind: 'frame' | 'locked' | 'fail' | 'exit' | 'silent'
  display?: string
  app?: string
  title?: string
  delayMs?: number
}

let backend: WindowsScreenCaptureBackend | undefined

afterEach(async () => {
  await backend?.shutdown()
  backend = undefined
})

/** A backend on the fake helper. `launches` counts helper starts. */
function fakeBackend(script: { replies?: Step[], exitBeforeReady?: boolean, readyDelayMs?: number }, options: { restartDelayMs?: number } = {}) {
  const launches: ChildProcessWithoutNullStreams[] = []
  backend = new WindowsScreenCaptureBackend({
    maxWidth: 1280,
    quality: 70,
    restartDelayMs: options.restartDelayMs,
    launch: () => {
      const child = spawn(process.execPath, [HELPER, JSON.stringify(script)])
      launches.push(child)
      return child
    },
  })
  return { backend, launches }
}

function signal(): AbortSignal {
  return AbortSignal.timeout(5000)
}

describe('windows capture backend', () => {
  it('turns a helper reply into a valid display frame with classified safety and a bounded title', async () => {
    const { backend } = fakeBackend({ replies: [{ kind: 'frame', app: 'Code', title: `main.ts ${'x'.repeat(400)}` }] })
    const before = Date.now()

    const frame = await backend.capture(signal())

    expect(() => validateFrame(frame)).not.toThrow()
    expect(frame.source.kind).toBe('display')
    expect(frame.source.generation).toBe(0)
    expect(frame.source.display_id).toBe('DISPLAY1|1920x1080@0,0')
    expect(frame.source.foreground_app).toBe('Code')
    expect(frame.source.window_title).toHaveLength(256)
    expect(frame.safety).toEqual({ locked: false, private_context: false, sensitive: false })
    expect(frame.image.mime_type).toBe('image/jpeg')
    expect([...frame.image.bytes]).toEqual([1, 1, 1])
    expect(frame.samples).toHaveLength(2304)
    expect(frame.captured_at).toBeGreaterThanOrEqual(before)
    expect(frame.captured_at).toBeLessThanOrEqual(Date.now())
  })

  it('leaves safety unknown for an unclassified app and marks sensitive titles, so automatic upload is denied', async () => {
    const { backend } = fakeBackend({ replies: [{ kind: 'frame', app: 'SomeGame' }, { kind: 'frame', app: 'msedge', title: 'Online Banking - Sign in' }] })
    const gate = new PrivacyGate()

    const unknown = await backend.capture(signal())
    expect(unknown.safety).toEqual({ locked: false })
    expect(gate.evaluate(unknown).state).toBe('UNKNOWN')
    expect(gate.evaluate(unknown, { authorize_unknown: true }).state).toBe('ALLOW')

    const sensitive = await backend.capture(signal())
    expect(sensitive.safety.sensitive).toBe(true)
    expect(gate.evaluate(sensitive, { authorize_unknown: true }).state).toBe('BLOCK')
  })

  it('reports a locked or secure desktop as a privacy failure, and a helper error as a capture failure', async () => {
    const { backend } = fakeBackend({ replies: [{ kind: 'locked' }, { kind: 'fail' }] })

    await expect(backend.capture(signal())).rejects.toMatchObject({ code: 'privacy' })
    await expect(backend.capture(signal())).rejects.toMatchObject({ code: 'invalid-capture' })
  })

  it('starts a new source generation when the display changes, and rejects the frame of the change', async () => {
    const { backend } = fakeBackend({ replies: [{ kind: 'frame' }, { kind: 'frame', display: 'DISPLAY1|2560x1440@0,0' }, { kind: 'frame', display: 'DISPLAY1|2560x1440@0,0' }] })
    const owner = new OwnedScreenCapture(backend)
    const changes: boolean[] = []
    backend.onSourceChange((available) => {
      changes.push(available)
      owner.sourceChanged(available)
    })

    expect((await owner.capture(signal())).source.generation).toBe(0)
    await expect(owner.capture(signal())).rejects.toMatchObject({ code: 'cancelled' })
    expect(changes).toEqual([true])
    const next = await owner.capture(signal())
    expect(next.source.generation).toBe(1)
    expect(next.source.display_id).toBe('DISPLAY1|2560x1440@0,0')
  })

  it('drops the late reply of a cancelled capture, so the next capture gets its own frame', async () => {
    const { backend } = fakeBackend({ replies: [{ kind: 'frame', delayMs: 300 }, { kind: 'frame' }] })
    const controller = new AbortController()

    const cancelled = backend.capture(controller.signal)
    setTimeout(() => controller.abort(), 50)
    await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' })

    const frame: ScreenFrame = await backend.capture(signal())
    expect([...frame.image.bytes]).toEqual([2, 2, 2])
  })

  it('fails pending captures when the helper exits, and starts a new helper on the next capture', async () => {
    const { backend, launches } = fakeBackend({ replies: [{ kind: 'exit' }, { kind: 'frame' }] })

    await expect(backend.capture(signal())).rejects.toMatchObject({ code: 'invalid-capture' })
    expect(launches).toHaveLength(1)
    // The new helper replays the script from its first step, which exits again.
    await expect(backend.capture(signal())).rejects.toMatchObject({ code: 'invalid-capture' })
    expect(launches).toHaveLength(2)
  })

  it('waits before starting again after a helper failed to start', async () => {
    const { backend, launches } = fakeBackend({ exitBeforeReady: true }, { restartDelayMs: 60_000 })

    await expect(backend.capture(signal())).rejects.toMatchObject({ code: 'invalid-capture' })
    await expect(backend.capture(signal())).rejects.toMatchObject({ code: 'invalid-capture' })
    expect(launches).toHaveLength(1)
  })

  it('ends the helper on shutdown and refuses later captures', async () => {
    const { backend, launches } = fakeBackend({ replies: [{ kind: 'silent' }] })
    backend.start()
    const pending = backend.capture(signal()).catch((error: unknown) => error)
    await new Promise(resolve => setTimeout(resolve, 100))

    await backend.shutdown()

    expect(await pending).toMatchObject({ code: 'source-lost' })
    expect(launches[0].exitCode ?? launches[0].signalCode).not.toBeNull()
    await expect(backend.capture(signal())).rejects.toMatchObject({ code: 'source-lost' })
  })
})

// Opt-in: captures the real primary display. Nothing is uploaded or saved, and the bytes are zeroed after each check.
describe.runIf(process.platform === 'win32' && process.env.COMPANION_CAPTURE_TEST === '1')('windows capture backend on this machine', () => {
  it('captures valid frames from the persistent helper within the capture timeout', async () => {
    backend = new WindowsScreenCaptureBackend({ maxWidth: 1280, quality: 70 })
    const owner = new OwnedScreenCapture(backend)
    backend.start()
    const timings: number[] = []
    for (let i = 0; i < 6; i++) {
      const started = performance.now()
      const frame = await owner.capture(AbortSignal.timeout(20_000))
      timings.push(performance.now() - started)
      expect(() => validateFrame(frame)).not.toThrow()
      frame.image.bytes.fill(0)
    }
    const steady = timings.slice(1).sort((a, b) => a - b)
    // Numbers only. Window titles and image bytes stay out of the output.
    console.info(JSON.stringify({ firstCaptureMs: Math.round(timings[0]), steadyP50Ms: Math.round(steady[Math.floor(steady.length / 2)]), steadyMaxMs: Math.round(steady.at(-1)!) }))
    expect(steady.at(-1)!).toBeLessThan(3000)
    await owner.shutdown()
  })
})
