#!/usr/bin/env tsx
import type { IncomingMessage, ServerResponse } from 'node:http'

import process from 'node:process'

import { Buffer } from 'node:buffer'
import { mkdirSync } from 'node:fs'
import { appendFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { errorMessageFrom } from '@moeru/std'
import { createServer as createChannel } from '@proj-airi/server-runtime/server'

import { loadOrCreateCredentials } from '../../src/auth/credentials'
import { DpapiSecretStore } from '../../src/auth/secret-store'

/** A synthetic key. The fake provider only checks that requests carry it. It is never a real credential. */
const FAKE_GEMINI_KEY = 'AIzaFAKE-ops-stack-key-0000000000000000'

/** Thinking tokens that the fake provider reports outside completion_tokens, like Gemini's compatible endpoint. */
const THINKING: Record<string, number> = { minimal: 0, low: 0, medium: 400, high: 650 }

/** A short spoken answer with an ACT token, so the stage shows an expression. */
function answerFor(text: string): string {
  if (/happy|great news/i.test(text))
    return '<|ACT:{"emotion":{"name":"happy","intensity":1}}|> That is wonderful news. I am really happy for you.'
  return 'Sure. That sounds good to me. I am right here with you.'
}

/** 16 kHz mono WAV with an amplitude-modulated tone, so lip sync sees changing loudness. */
function speechWav(text: string): Buffer {
  const rate = 16_000
  const samples = Math.floor(rate * Math.min(4, Math.max(1.5, text.length * 0.05)))
  const data = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    const t = i / rate
    data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * t) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t)) * 9000), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req)
    chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * A deterministic Gemini OpenAI-compatible provider on loopback: a model list with `models/` ids, streamed chat with
 * Gemini-style usage (thinking only in total_tokens), and speech for the stage. It records what each chat request
 * asked for, so a probe can check the model and effort that reached the provider. It never forwards anything.
 */
function fakeGemini(record: (entry: Record<string, unknown>) => void, log: (line: string) => void) {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors)
        res.end()
        return
      }
      const raw = await body(req)
      const keyed = req.headers.authorization === `Bearer ${FAKE_GEMINI_KEY}`
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json', ...cors })
        res.end(JSON.stringify({ object: 'list', data: ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash', 'tts-1'].map(id => ({ id: id.startsWith('gemini') ? `models/${id}` : id, object: 'model' })) }))
        return
      }
      if (req.url?.endsWith('/audio/speech')) {
        const input = (JSON.parse(raw || '{}') as { input?: string }).input ?? ''
        log(`speech ${input.length} chars`)
        res.writeHead(200, { 'content-type': 'audio/wav', ...cors })
        res.end(speechWav(input))
        return
      }
      if (req.url?.endsWith('/chat/completions')) {
        const parsed = JSON.parse(raw || '{}') as { model?: string, reasoning_effort?: string, stream_options?: unknown, messages?: Array<{ role: string, content?: unknown }> }
        record({ at: new Date().toISOString(), model: parsed.model, reasoningEffort: parsed.reasoning_effort ?? null, streamOptions: parsed.stream_options ?? null, keyed, messages: parsed.messages?.length ?? 0 })
        if (!keyed) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'missing key' } }))
          return
        }
        const last = [...(parsed.messages ?? [])].reverse().find(message => message.role === 'user')
        const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '')
        res.writeHead(200, { 'content-type': 'text/event-stream', ...cors })
        await new Promise(done => setTimeout(done, 600))
        const words = answerFor(text).split(/(?<= )/)
        for (const word of words) {
          res.write(`data: ${JSON.stringify({ id: 'ops', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: word } }] })}\n\n`)
          await new Promise(done => setTimeout(done, 30))
        }
        res.write(`data: ${JSON.stringify({ id: 'ops', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
        const prompt = 600 + (parsed.messages?.length ?? 0) * 40
        const completion = words.length * 2
        const thinking = THINKING[parsed.reasoning_effort ?? ''] ?? 0
        if ((parsed.stream_options as { include_usage?: boolean } | undefined)?.include_usage)
          res.write(`data: ${JSON.stringify({ id: 'ops', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion + thinking } })}\n\n`)
        res.end('data: [DONE]\n\n')
        return
      }
      res.writeHead(404, cors)
      res.end()
    })().catch((error: unknown) => {
      log(`provider error: ${errorMessageFrom(error) ?? 'unknown'}`)
      res.destroy()
    })
  })
}

/**
 * Prepares a disposable Core home for Ops integration runs and serves what the Core needs around it: AIRI's server
 * channel and a fake Gemini-compatible provider. Companion Ops then launches the real `companion-core serve` with
 * `COMPANION_CORE_HOME` set to this home. Nothing contacts a cloud provider and nothing bills.
 *
 * The home gets `companion-core.json` in the user's production shape (a free-tier fixture entry of 3.1 Flash-Lite
 * first, then a non-Gemini fallback) and DPAPI secrets: gateway tokens and the synthetic provider key.
 *
 * Usage: tsx eval/ops/ops-stack.mts --home <dir> --log <file> [--channel-port 6199] [--provider-port 18199]
 *
 * Call stack:
 *
 * main
 *   -> loadOrCreateCredentials / DpapiSecretStore.write (test home only)
 *   -> createChannel (server-runtime) -> fakeGemini
 */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'home': { type: 'string' }, 'log': { type: 'string' }, 'channel-port': { type: 'string' }, 'provider-port': { type: 'string' }, 'origin': { type: 'string', multiple: true } } })
  if (!values.home || !values.log)
    throw new Error('Usage: ops-stack.mts --home <dir> --log <file>')
  const home = values.home
  const logFile = values.log
  const log = (line: string) => void appendFile(logFile, `${new Date().toISOString()} ${line}\n`)
  mkdirSync(home, { recursive: true })
  const channelPort = Number(values['channel-port'] ?? 6199)
  const providerPort = Number(values['provider-port'] ?? 18199)
  const requestsFile = join(home, 'provider-requests.ndjson')

  const store = new DpapiSecretStore(join(home, 'secrets'))
  await loadOrCreateCredentials(store)
  await store.write('provider-gemini', FAKE_GEMINI_KEY)
  await store.write('provider-fallback', 'fake-fallback-key')
  const config = {
    port: 11980,
    profile: 'cloud-mura-voice',
    allowedOrigins: values.origin ?? ['http://127.0.0.1:5183', 'http://localhost:5183'],
    channel: { url: `ws://127.0.0.1:${channelPort}/ws` },
    perception: { enabled: false },
    watch: { sources: { mpv: { enabled: true, pipes: [{ name: 'airi-ops-mpv', player: 'mpv' }] } } },
    providers: {
      gemini: { baseURL: `http://127.0.0.1:${providerPort}/v1/`, keyRef: 'provider-gemini', compat: 'gemini' },
      fallback: { baseURL: `http://127.0.0.1:${providerPort}/fallback/v1/`, keyRef: 'provider-fallback' },
    },
    models: {
      'gemini-flash-lite-31': { provider: 'gemini', model: 'gemini-3.1-flash-lite', capabilities: { contextWindow: 1_000_000, maxOutput: 8192, images: true, structuredOutput: true }, limits: { rpm: 15, rpd: 500, tpm: 250_000, dayReset: { timeZone: 'America/Los_Angeles' } } },
      'fallback-model': { provider: 'fallback', model: 'fallback-1', capabilities: { contextWindow: 128_000 } },
    },
    aliases: { 'companion-chat': { role: 'conversation', chain: ['gemini-flash-lite-31', 'fallback-model'] } },
  }
  await writeFile(join(home, 'companion-core.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8')

  const channel = createChannel({ hostname: '127.0.0.1', port: channelPort })
  await channel.start()
  const provider = fakeGemini(entry => void appendFile(requestsFile, `${JSON.stringify(entry)}\n`), log)
  await new Promise<void>(done => provider.listen(providerPort, '127.0.0.1', done))
  await writeFile(join(home, 'stack-state.json'), `${JSON.stringify({ home, channel: `ws://127.0.0.1:${channelPort}/ws`, provider: `http://127.0.0.1:${providerPort}/v1/`, requests: requestsFile, pid: process.pid }, null, 2)}\n`, 'utf8')
  log('ops stack ready')
  console.info(`ops stack ready: home ${home}, channel ${channelPort}, provider ${providerPort}`)

  const stop = async () => {
    log('ops stack stopping')
    provider.close()
    await channel.stop?.()
    process.exit(0)
  }
  process.on('SIGINT', () => void stop())
  process.on('SIGTERM', () => void stop())
  setInterval(() => {}, 60_000)
}

main().catch((error: unknown) => {
  console.error(errorMessageFrom(error) ?? 'ops stack failed')
  process.exit(1)
})
