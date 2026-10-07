import type { Page } from 'playwright'

import type { CompanionConfig } from '../../../services/companion-core/src/config/config'

import process from 'node:process'

import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

import { DpapiSecretStore } from '../../../services/companion-core/src/auth/secret-store'
import { loadConfig, parseConfig, resolveHome } from '../../../services/companion-core/src/config/config'
import { createRedactor } from '../../../services/companion-core/src/logging/redact'
import { startGateway } from '../../../services/companion-core/src/server'

let phase = 'arguments'

const SAMPLE_RATE = 16_000

/** Public test phrases. They contain no personal data and ask for no tool. */
const CONVERSATION_PHRASES = [
  'Hi Airi, how was your day?',
  'I just got back from a long walk in the park.',
  'What kind of music do you like?',
  'Tell me one fun fact about cats.',
  'I am feeling a little tired today.',
  'What should I cook for dinner tonight?',
  'Do you prefer mornings or evenings?',
]

/** Synthesizes 16 kHz mono PCM in memory with Windows SAPI. No speech or credentials enter shell arguments. */
function synthesizePcm(text: string, rate = 0): Int16Array {
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())) | ConvertFrom-Json',
    '$s = [System.Speech.Synthesis.SpeechSynthesizer]::new()',
    '$s.Rate = $p.rate',
    '$m = [IO.MemoryStream]::new()',
    '$f = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
    '$s.SetOutputToAudioStream($m, $f)',
    '$s.Speak($p.text)',
    '$s.Dispose()',
    '[Console]::Out.Write([Convert]::ToBase64String($m.ToArray()))',
  ].join('; ')
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: Buffer.from(JSON.stringify({ text, rate })).toString('base64'),
    encoding: 'utf8',
    windowsHide: true,
    // A cold PowerShell start can take tens of seconds on a loaded machine.
    timeout: 60_000,
  })
  if (result.status !== 0)
    throw new Error(`Synthetic speech generation failed (status ${result.status}, signal ${result.signal}).`)
  const bytes = Buffer.from(result.stdout.trim(), 'base64')
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2))
}

function wav(samples: Int16Array): Uint8Array {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + samples.byteLength, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(samples.byteLength, 40)
  return Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)])
}

/** One microphone loop: each phrase, then enough silence for the reply to finish before the next phrase. */
function conversationFixture(gapSeconds: number): { audio: Uint8Array, loopSeconds: number } {
  const parts: Int16Array[] = [new Int16Array(SAMPLE_RATE * 2)]
  for (const phrase of CONVERSATION_PHRASES)
    parts.push(synthesizePcm(phrase), new Int16Array(SAMPLE_RATE * gapSeconds))
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const joined = new Int16Array(total)
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }
  return { audio: wav(joined), loopSeconds: total / SAMPLE_RATE }
}

function pcmVariant(samples: Int16Array, gain: number, noise: number): Int16Array {
  const output = Int16Array.from(samples)
  let seed = 42
  for (let i = 0; i < output.length; i++) {
    seed = (1664525 * seed + 1013904223) >>> 0
    const sample = output[i] * gain + (seed / 0xFFFFFFFF * 2 - 1) * noise * 32767
    output[i] = Math.max(-32768, Math.min(32767, Math.round(sample)))
  }
  return output
}

/** Loads the R2B configuration, isolates its state, and reads each provider key from protected storage. */
async function gatewayConfiguration(configFile: string, appOrigin: string | undefined) {
  const loaded = await loadConfig(configFile)
  const config: CompanionConfig = parseConfig({ ...loaded, port: 0, allowedOrigins: appOrigin ? [appOrigin] : [], store: { path: ':memory:' } })
  const store = new DpapiSecretStore(join(resolveHome(), 'secrets'))
  const providerKeys = new Map<string, string>()
  for (const provider of Object.values(config.providers)) {
    if (!provider.keyRef)
      continue
    const key = await store.read(provider.keyRef)
    if (key)
      providerKeys.set(provider.keyRef, key)
  }
  return { config, providerKeys }
}

async function configurePage(page: Page, options: { baseURL: string, token: string, chatModel: string }) {
  const microphone = await page.evaluate(async () => {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.find(device => device.kind === 'audioinput' && device.label.includes('Fake'))?.deviceId
  })
  await page.evaluate(({ baseURL, token, chatModel, microphone }) => {
    const providers = [
      { id: 'openai-compatible', model: chatModel, config: { baseUrl: baseURL, apiKey: token } },
      { id: 'openai-compatible-audio-transcription', model: 'companion-stt', config: { baseUrl: baseURL, apiKey: token, model: 'companion-stt', language: 'en' } },
      { id: 'openai-compatible-audio-speech', model: 'qwen3-tts', config: { baseUrl: 'http://127.0.0.1:11996/v1/', apiKey: 'local-mura', model: 'qwen3-tts', voice: 'mura' } },
    ]
    const credentials: Record<string, unknown> = {}
    const configured: Record<string, unknown> = {}
    const added: Record<string, boolean> = {}
    for (const provider of providers) {
      credentials[provider.id] = provider.config
      configured[provider.id] = { id: provider.id, definitionId: provider.id, config: provider.config, status: 'configured' }
      added[provider.id] = true
    }
    localStorage.setItem('settings/credentials/providers', JSON.stringify(credentials))
    localStorage.setItem('settings/providers/configured', JSON.stringify(configured))
    localStorage.setItem('settings/providers/added', JSON.stringify(added))
    const selections: Record<string, string> = {
      'onboarding/completed': 'true',
      'onboarding/skipped': 'false',
      'settings/consciousness/active-provider': 'openai-compatible',
      'settings/consciousness/active-model': chatModel,
      'settings/hearing/active-provider': 'openai-compatible-audio-transcription',
      'settings/hearing/active-model': 'companion-stt',
      'settings/hearing/auto-send-enabled': 'true',
      'settings/speech/active-provider': 'openai-compatible-audio-speech',
      'settings/speech/active-model': 'qwen3-tts',
      'settings/speech/voice': 'mura',
      'settings/speech/output-muted': 'false',
      'settings/audio/input/enabled': 'true',
      ...(microphone ? { 'settings/audio/input': microphone } : {}),
    }
    for (const [key, value] of Object.entries(selections))
      localStorage.setItem(key, value)
    const cards: Array<[string, { extensions: { airi: { modules: Record<string, unknown> } } }]> = JSON.parse(localStorage.getItem('airi-cards') ?? '[]')
    const active = localStorage.getItem('airi-card-active-id') ?? 'default'
    const card = cards.find(([id]) => id === active)?.[1]
    if (card) {
      card.extensions.airi.modules.consciousness = { provider: 'openai-compatible', model: chatModel }
      card.extensions.airi.modules.speech = { provider: 'openai-compatible-audio-speech', model: 'qwen3-tts', voice_id: 'mura' }
      localStorage.setItem('airi-cards', JSON.stringify(cards))
    }
  }, { ...options, microphone })
  await page.reload({ waitUntil: 'domcontentloaded' })
}

/** Vite serves workspace sources outside the app root under `/@fs/`. The page and the app then share module instances. */
function sourceURL(path: string) {
  return `/@fs/${resolve(fileURLToPath(new URL(path, import.meta.url))).replaceAll('\\', '/')}`
}

const SOURCES = {
  tracer: sourceURL('../../stage-ui/src/composables/use-io-tracer.ts'),
  voice: sourceURL('../../stage-ui/src/stores/voice.ts'),
  audio: sourceURL('../../stage-ui/src/stores/audio.ts'),
  sessions: sourceURL('../../stage-ui/src/stores/chat/session-store.ts'),
  devices: sourceURL('../../stage-ui/src/stores/settings/audio-device.ts'),
}

/**
 * Observes the running app without changing it: IO trace spans, VoiceController attempt states, and the speaking state.
 * Everything stays in page memory as names, attributes without text, and epoch milliseconds.
 */
async function installObserver(page: Page) {
  await page.evaluate(async (sources) => {
    const now = () => performance.timeOrigin + performance.now()
    const ms = (time: [number, number]) => time[0] * 1000 + time[1] / 1e6
    const tracer = await import(/* @vite-ignore */ sources.tracer)
    const { useVoiceStore } = await import(/* @vite-ignore */ sources.voice)
    const { useAudioContext, useSpeakingStore } = await import(/* @vite-ignore */ sources.audio)
    const { useSettingsAudioDevice } = await import(/* @vite-ignore */ sources.devices)
    const devices = useSettingsAudioDevice()
    const speaking = useSpeakingStore()
    const voiceStore = useVoiceStore()
    // waitForFunction treats a returned Promise as truthy, so the checks stay synchronous.
    const record: PageVoiceRecord = {
      spans: [],
      states: [],
      outputLatencyMs: 0,
      isSpeaking: () => speaking.nowSpeaking === true,
      // A response opens when the chat turn starts, so an open response without speech means the reply is still generating.
      isGenerating: () => voiceStore.activeTurns.length > 0 && speaking.nowSpeaking !== true,
      diagnose: () => ({ states: record.states.length, spans: record.spans.length, activeTurns: voiceStore.activeTurns.length, microphone: { enabled: devices.enabled === true, ready: !!devices.stream, error: devices.error ? String(devices.error).slice(0, 120) : undefined } }),
    }
    window.__r3Voice = record
    tracer.subscribeIOSpan((span: { name: string, startTime: [number, number], endTime: [number, number], attributes: Record<string, unknown>, events: Array<{ name: string, time: [number, number] }>, status: { code: number } }) => {
      const attributes: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(span.attributes)) {
        // Text attributes stay in the page. The report holds ids, flags, and numbers only.
        if (!/\.(?:text|asr\.text|raw_token|parameter)$/.test(key))
          attributes[key] = value
      }
      record.spans.push({ name: span.name, start: ms(span.startTime), end: ms(span.endTime), status: span.status.code, attributes, events: span.events.map(event => ({ name: event.name, time: ms(event.time) })) })
    })
    voiceStore.controller.onInput((attempt: { id: string, subscribe: (listener: (state: { phase: string, outcome?: { status: string } }) => void) => void }) => {
      record.states.push({ id: attempt.id, phase: 'begin', t: now() })
      attempt.subscribe(state => record.states.push({ id: attempt.id, phase: state.phase, outcome: state.outcome?.status, t: now() }))
    })
    const context = useAudioContext().audioContext as AudioContext
    record.outputLatencyMs = ((context.baseLatency ?? 0) + (context.outputLatency ?? 0)) * 1000
  }, SOURCES)
}

interface SpanRecord { name: string, start: number, end: number, status: number, attributes: Record<string, unknown>, events: Array<{ name: string, time: number }> }
interface StateRecord { id: string, phase: string, outcome?: string, t: number }
interface VoiceRecord { spans: SpanRecord[], states: StateRecord[], outputLatencyMs: number }

/** The observer record in the page. Its functions stay in the page. */
interface PageVoiceRecord extends VoiceRecord {
  isSpeaking: () => boolean
  isGenerating: () => boolean
  diagnose: () => unknown
}

declare global {
  interface Window {
    __r3Voice?: PageVoiceRecord
  }
}

/** Copies the serializable part of the page record. */
function readRecord(page: Page): Promise<VoiceRecord> {
  return page.evaluate(() => {
    const record = window.__r3Voice
    if (!record)
      throw new Error('The voice observer is not installed.')
    return { spans: record.spans, states: record.states, outputLatencyMs: record.outputLatencyMs }
  })
}

/** Joins one committed voice input with the spans that follow it, in time order, before the next input ends. */
function assembleTurns(spans: SpanRecord[], states: StateRecord[], outputLatencyMs: number) {
  const attempts = new Map<string, { finalizing?: number, outcome?: string }>()
  for (const state of states) {
    const attempt = attempts.get(state.id) ?? {}
    if (state.phase === 'finalizing')
      attempt.finalizing ??= state.t
    if (state.phase === 'settled')
      attempt.outcome = state.outcome
    attempts.set(state.id, attempt)
  }
  const committed = [...attempts.values()].filter(attempt => attempt.outcome === 'committed' && attempt.finalizing !== undefined).sort((a, b) => a.finalizing! - b.finalizing!)
  const byStart = [...spans].sort((a, b) => a.start - b.start)
  const turns = []
  for (const [index, attempt] of committed.entries()) {
    const from = attempt.finalizing!
    const until = committed[index + 1]?.finalizing ?? Number.POSITIVE_INFINITY
    const asr = byStart.find(span => span.name === 'Speech recognition' && span.end >= from && span.end < until && span.status !== 2)
    const llm = asr && byStart.find(span => span.name === 'LLM inference' && span.start >= asr.end - 50 && span.start < until)
    const firstToken = llm?.events.find(event => event.name.endsWith('llm.first_token'))?.time
    const tts = firstToken !== undefined ? byStart.find(span => span.name === 'TTS synthesis' && span.start >= firstToken - 50 && span.start < until && span.attributes['ai.moeru.airi.io.tts.canceled'] !== true) : undefined
    const turnId = tts?.attributes['ai.moeru.airi.io.turn_id']
    const playback = tts && byStart.find(span => span.name === 'Audio playback' && span.start >= tts.end - 5 && span.start < until && (turnId === undefined || span.attributes['ai.moeru.airi.io.turn_id'] === turnId))
    turns.push({
      sttToLlmStart: asr && llm ? llm.start - asr.end : undefined,
      vadEndToStt: asr ? asr.end - from : undefined,
      sttToFirstText: asr && firstToken !== undefined ? firstToken - asr.end : undefined,
      firstTextToTts: tts && firstToken !== undefined ? tts.end - firstToken : undefined,
      ttsToPlayback: playback && tts ? playback.start - tts.end + outputLatencyMs : undefined,
      total: playback ? playback.start + outputLatencyMs - from : undefined,
      interrupted: playback?.attributes['ai.moeru.airi.io.tts.interrupted'] === true,
    })
  }
  return turns
}

function distribution(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  const at = (p: number) => sorted.length ? Math.round(sorted[Math.ceil(sorted.length * p) - 1] * 10) / 10 : null
  const round = (value: number | undefined) => value === undefined ? null : Math.round(value * 10) / 10
  return { n: sorted.length, p50: at(0.5), p95: sorted.length >= 20 ? at(0.95) : null, min: round(sorted[0]), max: round(sorted.at(-1)) }
}

/**
 * Tests live Groq STT through an ephemeral R2B gateway, then measures the actual AIRI app.
 * The browser uses Chromium's file-backed microphone and upstream's VoiceController pipeline.
 * It reports metadata only and deletes the temporary browser context and fixture on close.
 *
 * Call stack:
 * main -> {@link startGateway} -> Groq audio
 *      -> Chromium -> AIRI VAD -> Gateway STT and R2B chat routing -> Mura TTS -> AIRI playback
 */
async function main() {
  const arg = (name: string) => process.argv.find(item => item.startsWith(`--${name}=`))?.slice(name.length + 3)
  const appURL = arg('app')
  const requested = Number(arg('samples') ?? 7)
  const spacingMs = Number(arg('spacing-ms') ?? 3100)
  const turnsWanted = Number(arg('turns') ?? 20)
  const maxMinutes = Number(arg('max-minutes') ?? 20)
  const gapSeconds = Number(arg('gap-seconds') ?? 30)
  const chatModel = arg('chat-model') ?? 'companion-chat'
  const configFile = arg('config') ?? fileURLToPath(new URL('../cases/r3-voice/gateway.r2b.json', import.meta.url))
  const bargeIn = process.argv.includes('--barge-in')
  const sttFailure = process.argv.includes('--stt-error')
  const pushToTalk = process.argv.includes('--push-to-talk')
  if (!Number.isInteger(requested) || requested < 0 || requested > 50 || !Number.isFinite(spacingMs) || spacingMs < 0)
    throw new Error('Use 0 through 50 samples and a nonnegative request spacing.')
  if (!Number.isInteger(turnsWanted) || turnsWanted < 1 || !(maxMinutes > 0) || !(maxMinutes <= 60) || !(gapSeconds >= 5) || !(gapSeconds <= 60))
    throw new Error('Use a positive turn count, at most 60 minutes, and a 5 to 60 second gap.')

  phase = 'R2B gateway configuration'
  const { config, providerKeys } = await gatewayConfiguration(configFile, appURL ? new URL(appURL).origin : undefined)
  if (!config.aliases['companion-stt'] || !config.aliases[chatModel])
    throw new Error('The configuration needs the companion-stt alias and the selected chat alias.')
  const credentials = { inference: randomBytes(32).toString('hex'), ops: randomBytes(32).toString('hex') }
  const redact = createRedactor([...providerKeys.values(), credentials.inference, credentials.ops])
  phase = 'ephemeral Gateway startup'
  // Gateway log lines are redacted metadata: path, model, status, outcome, and timings. They never hold message text.
  const chatLog: Array<{ model?: string, status: number, outcome: string, firstByteMs?: number }> = []
  const gateway = await startGateway({
    config,
    credentials,
    providerKeys,
    audioFetch: sttFailure ? async () => new Response(JSON.stringify({ error: { message: 'Voice test quota exhausted.', code: 'rate_limit_exceeded' } }), { status: 429 }) : undefined,
    writeLog: (line) => {
      const event = JSON.parse(line) as { path?: string, model?: string, status: number, outcome: string, firstByteMs?: number }
      if (event.path === '/v1/chat/completions')
        chatLog.push({ model: event.model, status: event.status, outcome: event.outcome, firstByteMs: event.firstByteMs })
    },
  })
  console.info(JSON.stringify({ gateway: 'started', profile: config.profile, chat: { alias: chatModel, chain: config.aliases[chatModel].chain }, stt: config.aliases['companion-stt'].chain }))
  const workDirectory = mkdtempSync(join(tmpdir(), 'r3-voice-'))
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
        let samples = synthesizePcm(phrases[index], index === 4 ? -3 : 0)
        if (index === 3)
          samples = pcmVariant(samples, 0.2, 0)
        if (index === 5)
          samples = pcmVariant(samples, 1, 0.025)
        audio = wav(samples)
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
    if (requested > 0)
      console.info(JSON.stringify({ sttOnly: true, count: requested, statuses, passed, latency: distribution(timings), wer: 'not measured' }))
    if (!appURL)
      return

    phase = 'microphone fixture synthesis'
    const fixture = conversationFixture(gapSeconds)
    const fixturePath = join(workDirectory, 'conversation.wav')
    writeFileSync(fixturePath, fixture.audio)
    phase = 'browser launch'
    let openPage: Page | undefined
    const browser = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fixturePath}`, '--autoplay-policy=no-user-gesture-required'] })
    try {
      const context = await browser.newContext({ permissions: ['microphone'] })
      // NOTICE:
      // tsx compiles this script with esbuild keepNames, which wraps named functions in `__name(...)`.
      // Functions passed to page.evaluate run in the page, where that helper does not exist.
      // Source: esbuild keepNames output. Removal condition: the runner stops injecting `__name`.
      await context.addInitScript({ content: 'globalThis.__name = (target) => target' })
      const page = await context.newPage()
      openPage = page
      const requests = { stt: 0, chat: 0, tts: 0 }
      const servedBy: Record<string, number> = {}
      const chatShapes: Array<{ messages: number, tools: number, promptCharacters: number }> = []
      const failures: string[] = []
      page.on('request', (request) => {
        const path = new URL(request.url()).pathname
        if (path.endsWith('/audio/transcriptions'))
          requests.stt++
        if (path.endsWith('/chat/completions')) {
          requests.chat++
          const body = request.postDataJSON() as { messages?: unknown[], tools?: unknown[] }
          chatShapes.push({ messages: body.messages?.length ?? 0, tools: body.tools?.length ?? 0, promptCharacters: JSON.stringify(body.messages ?? []).length })
        }
        if (path.endsWith('/audio/speech'))
          requests.tts++
      })
      page.on('response', (response) => {
        if (new URL(response.url()).pathname.endsWith('/chat/completions')) {
          const model = response.headers()['x-companion-model'] ?? `status-${response.status()}`
          servedBy[model] = (servedBy[model] ?? 0) + 1
        }
      })
      page.on('pageerror', error => failures.push(redact(error.message).slice(0, 300)))
      page.on('console', (message) => {
        if (message.type() === 'error')
          failures.push(redact(message.text()).slice(0, 300))
      })
      phase = 'AIRI startup'
      await page.goto(appURL, { waitUntil: 'domcontentloaded', timeout: 180_000 })
      await page.waitForTimeout(5000)
      await configurePage(page, { baseURL: gateway.baseURL, token: credentials.inference, chatModel })
      await page.waitForTimeout(5000)
      await installObserver(page)
      console.info(JSON.stringify({ capture: 'started', fixtureLoopSeconds: Math.round(fixture.loopSeconds), phrases: CONVERSATION_PHRASES.length, silenceHangoverMs: 1200 }))

      if (sttFailure) {
        phase = 'AIRI STT failure'
        await page.waitForFunction(() => window.__r3Voice?.states.some(state => state.outcome === 'failed') === true, undefined, { timeout: 90_000 })
        await page.waitForTimeout(3000)
        const visible = await page.getByText(/quota exhausted|rate limit|429|failed/i).first().isVisible().catch(() => false)
        console.info(JSON.stringify({ sttFailure: true, injectedProviderStatus: 429, errorTextVisible: visible, requests }))
        if (requests.chat !== 0 || requests.tts !== 0)
          throw new Error('A failed STT turn started downstream inference.')
        return
      }

      if (pushToTalk) {
        phase = 'AIRI push-to-talk'
        // The hold control sends begin, end, and cancel to the voice host. These calls use the same host functions.
        const result = await page.evaluate(async (sources) => {
          const { useVoiceStore } = await import(/* @vite-ignore */ sources.voice)
          const { useChatSessionStore } = await import(/* @vite-ignore */ sources.sessions)
          const voice = useVoiceStore()
          const sessionId = useChatSessionStore().activeSessionId as string
          await voice.stopListening()
          const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
          const settle = (attempt: { done: Promise<{ status: string }> }) => Promise.race([attempt.done.then(outcome => outcome.status), wait(30_000).then(() => 'timeout')])
          const discarded = voice.beginManual(sessionId)
          await wait(1500)
          voice.cancelInput()
          const discardedOutcome = await settle(discarded)
          const empty = voice.beginManual(sessionId)
          await wait(50)
          await voice.endInput()
          const emptyOutcome = await settle(empty)
          const held = voice.beginManual(sessionId)
          await wait(9000)
          await voice.endInput()
          const heldOutcome = await settle(held)
          return { discardedOutcome, emptyOutcome, heldOutcome }
        }, SOURCES)
        await page.waitForTimeout(3000)
        console.info(JSON.stringify({ pushToTalk: true, ...result, requests }))
        if (result.discardedOutcome !== 'cancelled' || result.heldOutcome !== 'committed')
          throw new Error('Push-to-talk discard or recovery failed.')
        return
      }

      let interruption: Record<string, unknown> | undefined
      if (bargeIn) {
        phase = 'AIRI barge-in'
        interruption = { cases: [] as unknown[] }
        for (const [label, waitFor, delayMs] of [['while the reply is generating', 'isGenerating', 300], ['500 ms after audible output', 'isSpeaking', 500], ['later TTS chunk', 'isSpeaking', 4000]] as const) {
          const cancelledBefore = chatLog.filter(event => event.outcome === 'cancelled').length
          await page.waitForFunction(check => window.__r3Voice?.[check]() === true, waitFor, { timeout: 180_000, polling: 50 })
          await page.waitForTimeout(delayMs)
          const result = await page.evaluate(async (sources) => {
            const { useSpeakingStore } = await import(/* @vite-ignore */ sources.audio)
            const { useVoiceStore } = await import(/* @vite-ignore */ sources.voice)
            const speaking = useSpeakingStore()
            const voice = useVoiceStore()
            const wasSpeaking = speaking.nowSpeaking as boolean
            const turns = [...voice.activeTurns]
            const start = performance.now()
            // The VAD plugin calls this same controller interruption when it detects speech onset.
            const interruption = voice.interrupt(turns, 'speech-input')
            const receipts = await interruption.silenced
            const silencedMs = performance.now() - start
            const deadline = performance.now() + 2000
            while (speaking.nowSpeaking && performance.now() < deadline)
              await new Promise(resolve => setTimeout(resolve, 10))
            return { wasSpeaking, turns: turns.length, silencedMs: Math.round(silencedMs), speakingAfterMs: Math.round(performance.now() - start), speakingAfter: speaking.nowSpeaking as boolean, receipts: receipts.map((receipt: { status: string }) => receipt.status), activeTurnsAfter: voice.activeTurns.length }
          }, SOURCES)
          // The gateway logs `cancelled` when the client closes a provider stream that is still open.
          await page.waitForTimeout(1500)
          const gatewayCancelled = chatLog.filter(event => event.outcome === 'cancelled').length - cancelledBefore
          ;(interruption.cases as unknown[]).push({ label, ...result, gatewayCancelled })
        }
      }

      phase = 'AIRI voice capture'
      const deadline = Date.now() + maxMinutes * 60_000
      let completed = 0
      while (Date.now() < deadline) {
        await page.waitForTimeout(10_000)
        const snapshot = await readRecord(page)
        completed = assembleTurns(snapshot.spans, snapshot.states, snapshot.outputLatencyMs).filter(turn => turn.total !== undefined).length
        if (completed >= turnsWanted + (bargeIn ? 2 : 0))
          break
      }
      await page.waitForTimeout(8000)
      const snapshot = await readRecord(page)
      const turns = assembleTurns(snapshot.spans, snapshot.states, snapshot.outputLatencyMs)
      const outcomes: Record<string, number> = {}
      for (const state of snapshot.states.filter(state => state.phase === 'settled'))
        outcomes[state.outcome ?? 'unknown'] = (outcomes[state.outcome ?? 'unknown'] ?? 0) + 1
      const complete = turns.filter(turn => turn.total !== undefined)
      console.info(JSON.stringify({
        airiEndToEnd: true,
        chatAlias: chatModel,
        requests,
        servedBy,
        attemptOutcomes: outcomes,
        turnsWithInput: turns.length,
        completedTurns: complete.length,
        outputLatencyMs: Math.round(snapshot.outputLatencyMs * 10) / 10,
        intervals: {
          vadEndToStt: distribution(complete.map(turn => turn.vadEndToStt!)),
          sttToLlmStart: distribution(complete.map(turn => turn.sttToLlmStart!)),
          sttToFirstText: distribution(complete.map(turn => turn.sttToFirstText!)),
          firstTextToTts: distribution(complete.map(turn => turn.firstTextToTts!)),
          ttsToPlayback: distribution(complete.map(turn => turn.ttsToPlayback!)),
          total: distribution(complete.map(turn => turn.total!)),
        },
        perTurnTotalMs: complete.map(turn => Math.round(turn.total!)),
        gatewayFirstByteMs: distribution(chatLog.filter(event => event.outcome === 'ok').map(event => event.firstByteMs!)),
        gatewayOutcomes: chatLog.reduce<Record<string, number>>((counts, event) => ({ ...counts, [`${event.model ?? 'none'}:${event.outcome}`]: (counts[`${event.model ?? 'none'}:${event.outcome}`] ?? 0) + 1 }), {}),
        promptShape: chatShapes.length ? { requests: chatShapes.length, tools: distribution(chatShapes.map(shape => shape.tools)), messages: distribution(chatShapes.map(shape => shape.messages)), promptCharacters: distribution(chatShapes.map(shape => shape.promptCharacters)) } : undefined,
        interruption,
        failures: [...new Set(failures)].slice(0, 12),
      }))
      if (complete.length < turnsWanted)
        throw new Error(`Only ${complete.length} of ${turnsWanted} voice turns completed.`)
    }
    catch (error) {
      const message = error instanceof Error ? error.message.split('\n')[0] : 'Unexpected browser failure'
      const diagnosis = await openPage?.evaluate(() => window.__r3Voice?.diagnose()).catch(() => undefined)
      console.error(JSON.stringify({ phase, error: redact(message).slice(0, 600), diagnosis }))
      throw error
    }
    finally {
      await browser.close()
    }
  }
  finally {
    await gateway.close()
    rmSync(workDirectory, { recursive: true, force: true })
  }
}

main().catch(() => {
  console.error(`R3 live voice probe failed during ${phase}. No credentials or provider response body were logged.`)
  process.exitCode = 1
})
