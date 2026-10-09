#!/usr/bin/env tsx
import type { IncomingMessage, ServerResponse } from 'node:http'

import process from 'node:process'

import { Buffer } from 'node:buffer'
import { mkdtempSync } from 'node:fs'
import { appendFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { errorMessageFrom } from '@moeru/std'
import { createServer as createChannel } from '@proj-airi/server-runtime/server'

import { parseConfig, startGateway } from '../../src'
import { CompanionRuntime } from '../../src/companion/runtime'
import { createMediaSources } from '../../src/companion/sources'

const INFERENCE = 'cc_inf_live-r7-inference-token-0000000000000000'
const OPS = 'cc_ops_live-r7-ops-token-00000000000000000000000'

/** A short spoken answer. A message that asks for joy gets an ACT emotion token first. */
function answerFor(text: string): string {
  if (/happy|great news/i.test(text))
    return '<|ACT:{"emotion":{"name":"happy","intensity":1}}|> That is wonderful news. I am really happy for you, and I want to hear everything about it.'
  return 'Sure. That sounds good to me. I am glad you asked, and I am right here with you.'
}

/** 16 kHz mono WAV with an amplitude-modulated tone, so lip sync sees changing loudness. */
function speechWav(text: string): Buffer {
  const rate = 16_000
  const seconds = Math.min(5, Math.max(1.5, text.length * 0.05))
  const samples = Math.floor(rate * seconds)
  const data = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    const t = i / rate
    const envelope = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t)
    data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * t) * envelope * 9000), i * 2)
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

/** A deterministic OpenAI-compatible provider: chat streams, a model list, and speech. No network beyond loopback. */
function fakeProvider(log: (line: string) => void) {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors)
        res.end()
        return
      }
      const raw = await body(req)
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json', ...cors })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'real-model', object: 'model' }, { id: 'tts-1', object: 'model' }] }))
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
        const parsed = JSON.parse(raw || '{}') as { messages?: Array<{ role: string, content?: unknown }> }
        const last = [...(parsed.messages ?? [])].reverse().find(message => message.role === 'user')
        const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '')
        log(`chat ${parsed.messages?.length ?? 0} messages`)
        res.writeHead(200, { 'content-type': 'text/event-stream', ...cors })
        // A visible thinking phase before the first token.
        await new Promise(done => setTimeout(done, 1500))
        for (const word of answerFor(text).split(/(?<= )/)) {
          res.write(`data: ${JSON.stringify({ id: 'live', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: word } }] })}\n\n`)
          await new Promise(done => setTimeout(done, 40))
        }
        res.write(`data: ${JSON.stringify({ id: 'live', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
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
 * Starts a disposable local stack for real Stage validation: AIRI's server channel, a deterministic fake provider,
 * and the full Core runtime and gateway on the companion port 11980, so the stage sends turn identity.
 * mpv can join through a named pipe. Nothing contacts a cloud provider.
 *
 * Usage: tsx eval/director/live-stack.mts --state <state.json> --log <log.txt> [--channel-port 6199] [--provider-port 18199] [--pipe airi-live-r7]
 *
 * Call stack:
 *
 * main
 *   -> createChannel (server-runtime) -> fakeProvider
 *   -> CompanionRuntime.open (memory, watch with mpv source, Director) -> startGateway(port 11980)
 */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'state': { type: 'string' }, 'log': { type: 'string' }, 'channel-port': { type: 'string' }, 'provider-port': { type: 'string' }, 'pipe': { type: 'string' } } })
  if (!values.state || !values.log)
    throw new Error('Usage: live-stack.mts --state <file> --log <file>')
  const logFile = values.log
  const log = (line: string) => void appendFile(logFile, `${new Date().toISOString()} ${line}\n`)
  const channelPort = Number(values['channel-port'] ?? 6199)
  const channel = createChannel({ hostname: '127.0.0.1', port: channelPort })
  await channel.start()
  const provider = fakeProvider(log)
  // A fixed port keeps the stage's saved speech provider valid across stack restarts.
  await new Promise<void>(done => provider.listen(Number(values['provider-port'] ?? 18199), '127.0.0.1', done))
  const providerPort = (provider.address() as { port: number }).port
  const home = mkdtempSync(join(tmpdir(), 'r7-live-'))
  const pipe = values.pipe ?? 'airi-live-r7'
  const config = parseConfig({
    port: 11980,
    allowedOrigins: ['http://127.0.0.1:5183', 'http://localhost:5183'],
    store: { path: ':memory:' },
    channel: { url: `ws://127.0.0.1:${channelPort}/ws` },
    memory: { path: join(home, 'memory.sqlite') },
    perception: { enabled: false },
    providers: { fake: { baseURL: `http://127.0.0.1:${providerPort}/v1/`, keyRef: 'provider-fake' } },
    models: { 'fake-model': { provider: 'fake', model: 'real-model', capabilities: { contextWindow: 32_000 } } },
    aliases: { 'companion-chat': { chain: ['fake-model'] } },
    watch: { sources: { mpv: { enabled: true, pipes: [{ name: pipe, player: 'mpv' }] } } },
  })
  const mediaSources = createMediaSources(config.watch.sources, {}, { now: Date.now, hostname: 'live-r7', lookup: async () => [], report: log })
  const companion = await CompanionRuntime.open({ config, home, channel: true, report: log, mediaSources })
  const gateway = await startGateway({ config, credentials: { inference: INFERENCE, ops: OPS }, providerKeys: new Map([['provider-fake', 'fake-key']]), companion, writeLog: line => log(`gateway ${line}`) })
  companion.attach(gateway.runtime, { baseURL: gateway.baseURL, token: INFERENCE })
  await writeFile(values.state, `${JSON.stringify({ gateway: gateway.baseURL, ops: OPS, inference: INFERENCE, channel: `ws://127.0.0.1:${channelPort}/ws`, provider: `http://127.0.0.1:${providerPort}/v1/`, pipe, home, pid: process.pid }, null, 2)}\n`, 'utf8')
  log('stack ready')
  console.info(`live stack ready: gateway ${gateway.baseURL}, channel ${channelPort}, provider ${providerPort}`)

  let stopping = false
  const stop = async () => {
    if (stopping)
      return
    stopping = true
    log('stack stopping')
    await companion.director?.close()
    await companion.watch?.shutdown()
    await gateway.close()
    await companion.close()
    provider.close()
    await channel.stop?.()
    process.exit(0)
  }
  process.on('SIGINT', () => void stop())
  process.on('SIGTERM', () => void stop())
  // Keeps the process alive until a signal stops it.
  setInterval(() => {}, 60_000)
}

main().catch((error: unknown) => {
  console.error(errorMessageFrom(error) ?? 'live stack failed')
  process.exit(1)
})
