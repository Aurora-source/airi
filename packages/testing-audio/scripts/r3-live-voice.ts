import type { Page } from 'playwright'

import process from 'node:process'

import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

import { loadGroqKey } from '../../../services/companion-core/src/audio/audio-config'
import { DpapiSecretStore } from '../../../services/companion-core/src/auth/secret-store'
import { loadConfig, parseConfig, resolveHome } from '../../../services/companion-core/src/config/config'
import { createRedactor } from '../../../services/companion-core/src/logging/redact'
import { startGateway } from '../../../services/companion-core/src/server'

let phase = 'credentials'

/** Generates a public test phrase in memory. No speech or credentials enter shell arguments. */
function synthesize(text: string, rate = 0): Uint8Array {
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())) | ConvertFrom-Json',
    '$s = [System.Speech.Synthesis.SpeechSynthesizer]::new()',
    '$s.Rate = $p.rate',
    '$m = [IO.MemoryStream]::new()',
    '$s.SetOutputToWaveStream($m)',
    '$s.Speak($p.text)',
    '$s.Dispose()',
    '[Console]::Out.Write([Convert]::ToBase64String($m.ToArray()))',
  ].join('; ')
  const result = spawnSync('rtk', ['proxy', 'powershell', '-NoProfile', '-NonInteractive', '-Command', script], {
    input: Buffer.from(JSON.stringify({ text, rate })).toString('base64'),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  })
  if (result.status !== 0)
    throw new Error('Synthetic speech generation failed.')
  return new Uint8Array(Buffer.from(result.stdout.trim(), 'base64'))
}

function pcmVariant(bytes: Uint8Array, gain: number, noise: number): Uint8Array {
  const output = Uint8Array.from(bytes)
  const view = new DataView(output.buffer)
  let offset = 12
  let seed = 42
  while (offset + 8 <= bytes.length) {
    const name = Buffer.from(bytes.subarray(offset, offset + 4)).toString('ascii')
    const length = view.getUint32(offset + 4, true)
    if (name === 'data') {
      for (let i = offset + 8; i + 1 < Math.min(offset + 8 + length, bytes.length); i += 2) {
        seed = (1664525 * seed + 1013904223) >>> 0
        const sample = view.getInt16(i, true) * gain + (seed / 0xFFFFFFFF * 2 - 1) * noise * 32767
        view.setInt16(i, Math.max(-32768, Math.min(32767, Math.round(sample))), true)
      }
      break
    }
    offset += 8 + length + (length % 2)
  }
  return output
}

async function configurePage(page: Page, baseURL: string, token: string, pushToTalk: boolean) {
  await page.evaluate(({ baseURL, token, pushToTalk }) => {
    const providers = [
      { id: 'openai-compatible', model: 'companion-chat', config: { baseUrl: baseURL, apiKey: token } },
      { id: 'openai-compatible-audio-transcription', model: 'companion-stt', config: { baseUrl: baseURL, apiKey: token, model: 'companion-stt', language: 'en' } },
      { id: 'openai-compatible-audio-speech', model: 'qwen3-tts', config: { baseUrl: 'http://127.0.0.1:11996/v1/', apiKey: 'local-mura', model: 'qwen3-tts', voice: 'mura' } },
    ]
    const credentials: Record<string, unknown> = {}
    const configured: Record<string, unknown> = {}
    const added: Record<string, boolean> = {}
    for (const provider of providers) {
      credentials[provider.id] = provider.config
      configured[provider.id] = { ...provider, definitionId: provider.id, status: 'configured' }
      added[provider.id] = true
    }
    localStorage.setItem('settings/credentials/providers', JSON.stringify(credentials))
    localStorage.setItem('settings/providers/configured', JSON.stringify(configured))
    localStorage.setItem('settings/providers/added', JSON.stringify(added))
    const selections = {
      'onboarding/completed': 'true',
      'settings/consciousness/active-provider': 'openai-compatible',
      'settings/consciousness/active-model': 'companion-chat',
      'settings/hearing/active-provider': 'openai-compatible-audio-transcription',
      'settings/hearing/active-model': 'companion-stt',
      'settings/speech/active-provider': 'openai-compatible-audio-speech',
      'settings/speech/active-model': 'qwen3-tts',
      'settings/speech/voice': 'mura',
      'settings/speech/output-muted': 'false',
      'settings/audio/input/enabled': 'true',
      'settings/voice-input/mode': pushToTalk ? 'push-to-talk' : 'continuous',
      'settings/voice-input/output-device': 'headphones',
    }
    for (const [key, value] of Object.entries(selections))
      localStorage.setItem(key, value)
    const cards: Array<[string, { extensions: { airi: { modules: Record<string, unknown> } } }]> = JSON.parse(localStorage.getItem('airi-cards') ?? '[]')
    const active = localStorage.getItem('airi-card-active-id') ?? 'default'
    const card = cards.find(([id]) => id === active)?.[1]
    if (card) {
      card.extensions.airi.modules.consciousness = { provider: 'openai-compatible', model: 'companion-chat' }
      card.extensions.airi.modules.speech = { provider: 'openai-compatible-audio-speech', model: 'qwen3-tts', voice_id: 'mura' }
      localStorage.setItem('airi-cards', JSON.stringify(cards))
    }
    sessionStorage.setItem('airi/r3/voice-latency', 'true')
  }, { baseURL, token, pushToTalk })
  await page.reload({ waitUntil: 'domcontentloaded' })
}

/**
 * Tests live Groq through the Gateway, then optionally measures the actual AIRI app.
 * The browser uses Chromium's native file-backed microphone and upstream playback.
 * It reports metadata only and deletes the temporary browser context on close.
 *
 * Call stack:
 * main -> {@link startGateway} -> Groq audio
 *      -> Chromium -> AIRI VAD -> Gateway STT/chat -> Mura -> AIRI playback
 */
async function main() {
  const appArg = process.argv.find(arg => arg.startsWith('--app='))
  const appURL = appArg?.slice('--app='.length)
  const requested = Number(process.argv.find(arg => arg.startsWith('--samples='))?.split('=')[1] ?? 7)
  const spacingMs = Number(process.argv.find(arg => arg.startsWith('--spacing-ms='))?.split('=')[1] ?? 3100)
  const captureMs = Number(process.argv.find(arg => arg.startsWith('--capture-ms='))?.split('=')[1] ?? 120_000)
  const minCompleted = Number(process.argv.find(arg => arg.startsWith('--min-completed='))?.split('=')[1] ?? 1)
  const bargeIn = process.argv.includes('--barge-in')
  const pushToTalk = process.argv.includes('--push-to-talk')
  const sttFailure = process.argv.includes('--stt-error')
  if (!Number.isInteger(requested) || requested < 0 || requested > 50 || !Number.isFinite(spacingMs) || spacingMs < 0)
    throw new Error('Use 0 through 50 samples and a nonnegative request spacing.')
  if (!Number.isFinite(captureMs) || captureMs < 0 || captureMs > 3_600_000 || !Number.isInteger(minCompleted) || minCompleted < 1)
    throw new Error('Use a bounded capture duration and a positive completed-sample minimum.')
  const store = new DpapiSecretStore(join(resolveHome(), 'secrets'))
  phase = 'protected Groq credential'
  const groq = await loadGroqKey(store, 'provider-groq')
  if (!groq)
    throw new Error('The protected Groq credential is unavailable.')
  phase = 'chat configuration'
  const configFile = process.argv.find(arg => arg.startsWith('--config='))?.slice('--config='.length)
  const config = await loadConfig(configFile)
  const providerKeys = new Map<string, string>([['provider-groq', groq]])
  for (const provider of Object.values(config.providers)) {
    const key = await store.read(provider.keyRef)
    if (key)
      providerKeys.set(provider.keyRef, key)
  }
  const credentials = { inference: randomBytes(32).toString('hex'), ops: randomBytes(32).toString('hex') }
  const redact = createRedactor([...providerKeys.values(), credentials.inference, credentials.ops])
  phase = 'ephemeral Gateway startup'
  const gateway = await startGateway({
    config: parseConfig({ ...config, port: 0, allowedOrigins: appURL ? [new URL(appURL).origin] : [] }),
    credentials,
    providerKeys,
    audioConfig: { profile: 'cloud-mura' },
    audioFetch: sttFailure ? async () => new Response(JSON.stringify({ error: { message: 'Voice test quota exhausted.', code: 'rate_limit_exceeded' } }), { status: 429 }) : undefined,
    writeLog: () => {},
  })
  try {
    phase = 'STT corpus'
    const phrases = [
      'Please say hello.',
      'I had a long day at work. Can we talk about something relaxing for a minute?',
      'Hello, Airi! How are you today?',
      'Could you tell me a short story?',
      'I am speaking slowly so you can understand me.',
      'Please say hello.',
    ]
    let passed = 0
    const timings: number[] = []
    const statuses: Record<string, number> = {}
    let japaneseAudio: Uint8Array | undefined
    for (let i = 0; i < requested; i++) {
      const index = i % 7
      let audio: Uint8Array
      if (index === 6) {
        // Spesco, CC BY-SA 4.0. Original unchanged and fetched only into memory.
        // https://commons.wikimedia.org/wiki/File:Ja-konnichiwa.ogg
        phase = `STT corpus sample ${i + 1}: Japanese sample download`
        if (!japaneseAudio) {
          const response = await fetch('https://upload.wikimedia.org/wikipedia/commons/d/db/Ja-konnichiwa.ogg', { signal: AbortSignal.timeout(20_000) })
          if (!response.ok)
            throw new Error('Japanese public sample download failed.')
          japaneseAudio = new Uint8Array(await response.arrayBuffer())
        }
        audio = japaneseAudio
      }
      else {
        phase = `STT corpus sample ${i + 1}: test phrase synthesis`
        audio = synthesize(phrases[index], index === 4 ? -3 : 0)
        if (index === 3)
          audio = pcmVariant(audio, 0.2, 0)
        if (index === 5)
          audio = pcmVariant(audio, 1, 0.025)
      }
      const form = new FormData()
      form.set('model', 'companion-stt')
      form.set('file', new Blob([Uint8Array.from(audio).buffer], { type: index === 6 ? 'audio/ogg' : 'audio/wav' }), index === 6 ? 'sample.ogg' : 'sample.wav')
      form.set('language', index === 6 ? 'ja' : 'en')
      phase = `STT corpus sample ${i + 1}: transcription request`
      const start = performance.now()
      const response = await fetch(`${gateway.baseURL}audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${credentials.inference}` }, body: form })
      const result = await response.json() as { text?: string }
      const ms = Math.round(performance.now() - start)
      const normalized = (text: string) => text.toLowerCase().replace(/[^a-z\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu, '')
      const expected = index === 6 ? 'こんにちは' : phrases[index]
      const pass = response.ok && normalized(result.text ?? '').includes(normalized(expected))
      const punctuationPresent = index === 2 ? /[.!?]/.test(result.text ?? '') : undefined
      if (pass)
        passed++
      statuses[String(response.status)] = (statuses[String(response.status)] ?? 0) + 1
      if (response.ok)
        timings.push(ms)
      console.info(JSON.stringify({ test: index === 6 ? 'Japanese' : ['short', 'long', 'punctuation', 'quiet', 'slow', 'noise'][index], status: response.status, pass, punctuationPresent, latencyMs: ms }))
      if (i + 1 < requested) {
        const retrySeconds = Number(response.headers.get('retry-after') ?? 0)
        const delay = response.status === 429 && Number.isFinite(retrySeconds) ? Math.max(spacingMs, retrySeconds * 1000) : spacingMs
        await new Promise(resolve => setTimeout(resolve, Math.min(delay, 60_000)))
      }
    }
    timings.sort((a, b) => a - b)
    console.info(JSON.stringify({ sttOnly: true, count: requested, statuses, passed, successLatencyCount: timings.length, p50: timings[Math.ceil(timings.length * 0.5) - 1] ?? null, p95: timings.length >= 20 ? timings[Math.ceil(timings.length * 0.95) - 1] : null, wer: 'not measured' }))
    if (!appURL)
      return
    phase = 'browser launch'
    const fixture = resolve(fileURLToPath(new URL('../cases/single-utterance-pipeline/input.test.wav', import.meta.url)))
    const browser = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fixture}`, '--autoplay-policy=no-user-gesture-required'] })
    try {
      const context = await browser.newContext({ permissions: ['microphone'] })
      const page = await context.newPage()
      const requests = { stt: 0, chat: 0, tts: 0 }
      const failures: string[] = []
      const chatRequests: Array<{ model: string, messages: number, promptCharacters: number }> = []
      page.on('request', (request) => {
        const path = new URL(request.url()).pathname
        if (path.endsWith('/audio/transcriptions'))
          requests.stt++
        if (path.endsWith('/chat/completions')) {
          requests.chat++
          const body = request.postDataJSON() as { model?: string, messages?: Array<{ content?: unknown }> }
          chatRequests.push({ model: body.model ?? '', messages: body.messages?.length ?? 0, promptCharacters: JSON.stringify(body.messages ?? []).length })
        }
        if (path.endsWith('/audio/speech'))
          requests.tts++
      })
      page.on('pageerror', error => failures.push(redact(error.message).slice(0, 600)))
      page.on('console', (message) => {
        if (message.type() === 'error')
          failures.push(redact(message.text()).slice(0, 600))
      })
      phase = 'AIRI startup'
      await page.goto(appURL, { waitUntil: 'domcontentloaded', timeout: 120_000 })
      await page.waitForTimeout(5000)
      await configurePage(page, gateway.baseURL, credentials.inference, pushToTalk)
      phase = 'AIRI voice capture'
      if (pushToTalk) {
        phase = 'AIRI push-to-talk blur check'
        const button = page.getByRole('button', { name: 'Hold to talk' })
        await button.waitFor({ timeout: 30_000 })
        await button.focus()
        await page.keyboard.down('Space')
        await page.waitForTimeout(100)
        await page.keyboard.press('Tab')
        if (process.argv.includes('--debug-ui')) {
          console.info(JSON.stringify(await page.evaluate(() => ({
            path: location.pathname,
            focusedTag: document.activeElement?.tagName,
            modeSelectPresent: !!document.querySelector('[aria-label="Voice listening mode"]'),
            heldButtons: [...document.querySelectorAll('button')].filter(button => /Hold to talk|Listening/.test(button.textContent ?? '')).map(button => ({ label: button.textContent?.trim(), pressed: button.getAttribute('aria-pressed') })),
          }))))
        }
        await page.getByRole('combobox', { name: 'Voice listening mode' }).focus({ timeout: 2000 })
        await page.keyboard.up('Space')
        await button.waitFor({ timeout: 5000 })
        if (await button.getAttribute('aria-pressed') !== 'false')
          throw new Error('Focus loss left push-to-talk recording active.')
        if (requests.stt !== 0)
          throw new Error('Focus loss submitted a discarded push-to-talk recording.')
        phase = 'AIRI push-to-talk capture'
        await button.dispatchEvent('pointerdown')
        await page.getByRole('button', { name: 'Listening…' }).dispatchEvent('pointerup')
        await button.waitFor({ timeout: 5000 })
        await button.dispatchEvent('pointerdown')
        await page.waitForTimeout(18_000)
        await page.getByRole('button', { name: 'Listening…' }).dispatchEvent('pointerup')
      }
      if (sttFailure) {
        await page.getByText('Voice input failed', { exact: true }).first().waitFor({ timeout: 60_000 })
        console.info(JSON.stringify({ sttFailureVisible: true, injectedProviderStatus: 429, requests }))
        if (requests.chat !== 0 || requests.tts !== 0)
          throw new Error('A failed STT turn started downstream inference.')
        return
      }
      const sourceURL = (path: string) => `/@fs/${resolve(fileURLToPath(new URL(path, import.meta.url))).replaceAll('\\', '/')}`
      let interruption: { stopLatencyMs: number, speakingAfterStop: boolean } | undefined
      if (bargeIn) {
        const speakingURL = sourceURL('../../stage-ui/src/stores/audio.ts')
        const controlURL = sourceURL('../../stage-ui/src/stores/speech-output-control.ts')
        const latencyURL = sourceURL('../../stage-ui/src/libs/voice/voice-latency.ts')
        const deadline = Date.now() + 60_000
        let started = false
        while (Date.now() < deadline) {
          started = await page.evaluate(async ({ speakingURL, latencyURL }) => {
            const speaking = (await import(/* @vite-ignore */ speakingURL)).useSpeakingStore()
            const trace = (await import(/* @vite-ignore */ latencyURL)).voiceLatencyTrace
            return speaking.nowSpeaking === true && trace.snapshot().some((sample: { playbackStartedAt?: number }) => sample.playbackStartedAt !== undefined)
          }, { speakingURL, latencyURL })
          if (started)
            break
          await page.waitForTimeout(100)
        }
        if (!started)
          throw new Error('AIRI did not begin a measured speech response.')
        await page.waitForTimeout(500)
        // Exercises the mounted Stage's real stop/cancel path. This injects the
        // speech-start signal; it does not measure microphone/VAD detection.
        interruption = await page.evaluate(async ({ speakingURL, controlURL }) => {
          const speaking = (await import(/* @vite-ignore */ speakingURL)).useSpeakingStore()
          const control = (await import(/* @vite-ignore */ controlURL)).useSpeechOutputControlStore()
          const start = performance.now()
          control.requestStopSpeaking('user-speech')
          return { stopLatencyMs: performance.now() - start, speakingAfterStop: speaking.nowSpeaking }
        }, { speakingURL, controlURL })
      }
      await page.waitForTimeout(captureMs)
      const moduleURL = `/@fs/${resolve(fileURLToPath(new URL('../../stage-ui/src/libs/voice/voice-latency.ts', import.meta.url))).replaceAll('\\', '/')}`
      const summary = await page.evaluate(async (url) => {
        const module = await import(/* @vite-ignore */ url)
        return { summary: module.voiceLatencyTrace.summary(), samples: module.voiceLatencyTrace.snapshot() }
      }, moduleURL)
      console.info(JSON.stringify({ airiEndToEnd: true, requests, chatRequests, failures: [...new Set(failures)].slice(0, 12), interruption, ...summary }))
      if (summary.summary.completed < minCompleted || (interruption && (summary.summary.interrupted < 1 || interruption.speakingAfterStop || interruption.stopLatencyMs > 300)))
        throw new Error('The AIRI capture or interruption acceptance check failed.')
    }
    catch (error) {
      const message = error instanceof Error ? error.message.split('\n')[0] : 'Unexpected browser failure'
      console.error(JSON.stringify({ phase, error: redact(message).slice(0, 600) }))
      throw error
    }
    finally {
      await browser.close()
    }
  }
  finally {
    await gateway.close()
  }
}

main().catch(() => {
  console.error(`R3 live voice probe failed during ${phase}. No credentials or provider response body were logged.`)
  process.exitCode = 1
})
