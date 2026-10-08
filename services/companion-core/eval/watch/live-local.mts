#!/usr/bin/env tsx
import type { Socket } from 'node:net'

import process from 'node:process'

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { connect, createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'

import { errorMessageFrom } from '@moeru/std'
import { createServer as createChannel } from '@proj-airi/server-runtime/server'

import { parseConfig, startGateway } from '../../src'
import { CompanionRuntime } from '../../src/companion/runtime'
import { createMediaSources } from '../../src/companion/sources'

async function freePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  await new Promise(done => server.close(done))
  return typeof address === 'object' && address ? address.port : 0
}

async function waitFor<T>(read: () => T, check: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let value = read()
  while (!check(value)) {
    if (Date.now() > deadline)
      throw new Error(`timed out: ${JSON.stringify(value).slice(0, 400)}`)
    await new Promise(done => setTimeout(done, 20))
    value = read()
  }
  return value
}

async function openPipe(pipe: string): Promise<Socket> {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const socket = connect(`\\\\.\\pipe\\${pipe}`)
        socket.once('connect', () => resolve(socket))
        socket.once('error', reject)
      })
    }
    catch {
      await new Promise(done => setTimeout(done, 100))
    }
  }
  throw new Error('mpv pipe did not open')
}

/**
 * Live validation of desktop players through the whole Core runtime: real mpv and real VLC, the configured sources,
 * the source manager, WatchState, the WATCH block, and Ops selection. The players run with command-line options only,
 * so the user's mpv.conf and VLC settings stay unchanged. Probe-only control clients drive the players.
 *
 * Usage: tsx eval/watch/live-local.mts --mpv <mpv.exe> --vlc <vlc.exe> --show <file> --other <file> --out <result.json>
 *
 * Call stack:
 *
 * main
 *   -> createMediaSources (mpv + VLC) -> CompanionRuntime.open -> startGateway
 *   -> spawn mpv --input-ipc-server, spawn vlc --extraintf=http --http-host=127.0.0.1
 *   -> CompanionWatch.toolStatus / unit / status / selectSource checks
 */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { mpv: { type: 'string' }, vlc: { type: 'string' }, show: { type: 'string' }, other: { type: 'string' }, out: { type: 'string' } } })
  if (!values.mpv || !values.vlc || !values.show || !values.other || !values.out)
    throw new Error('Usage: live-local.mts --mpv <exe> --vlc <exe> --show <file> --other <file> --out <file>')
  const results: Record<string, unknown> = {}
  const check = async (name: string, run: () => Promise<unknown>) => {
    try {
      results[name] = { ok: true, detail: await run() }
    }
    catch (error) {
      results[name] = { ok: false, error: errorMessageFrom(error) ?? 'unknown' }
    }
    console.info(name, JSON.stringify(results[name]).slice(0, 400))
  }

  const pipe = `airi-live-${randomUUID().slice(0, 8)}`
  const vlcPort = await freePort()
  const vlcPassword = randomBytes(12).toString('base64url')
  const port = await freePort()
  const channel = createChannel({ hostname: '127.0.0.1', port })
  await channel.start()
  const home = mkdtempSync(join(tmpdir(), 'r6-local-'))
  const config = parseConfig({
    port: 0,
    store: { path: ':memory:' },
    channel: { url: `ws://127.0.0.1:${port}/ws` },
    memory: { path: join(home, 'memory.sqlite') },
    providers: { fake: { baseURL: 'http://127.0.0.1:9/v1/', keyRef: 'provider-fake' } },
    models: { 'fake-model': { provider: 'fake', model: 'none', capabilities: { contextWindow: 32_000 } } },
    aliases: { 'companion-chat': { chain: ['fake-model'] } },
    watch: { sources: { mpv: { enabled: true, pipes: [{ name: pipe, player: 'mpv' }] }, vlc: { enabled: true, port: vlcPort } } },
  })
  const reports: string[] = []
  const mediaSources = createMediaSources(config.watch.sources, { vlcPassword }, { now: Date.now, hostname: 'probe-host', lookup: async () => [], report: line => reports.push(line) })
  const companion = await CompanionRuntime.open({ config, home, channel: true, report: line => reports.push(line), mediaSources })
  const gateway = await startGateway({ config, credentials: { inference: 'cc_inf_live-probe-inference-token-000000000000', ops: 'cc_ops_live-probe-ops-token-0000000000000000' }, providerKeys: new Map(), companion, writeLog: () => {} })
  companion.attach(gateway.runtime)
  const watch = companion.watch!
  const tool = () => watch.toolStatus() as Record<string, any>
  const ops = () => watch.status() as Record<string, any>

  const mpv = spawn(values.mpv, ['--no-config', `--input-ipc-server=\\\\.\\pipe\\${pipe}`, '--sid=1', '--vo=null', '--ao=null', '--keep-open=no', '--really-quiet', values.show], { stdio: 'ignore', windowsHide: true })
  const control = await openPipe(pipe)
  const mpvCommand = (...words: unknown[]) => control.write(`${JSON.stringify({ command: words })}\n`)
  let vlc: ReturnType<typeof spawn> | undefined
  const vlcCommand = (query: string) => fetch(`http://127.0.0.1:${vlcPort}/requests/status.json?${query}`, { headers: { Authorization: `Basic ${Buffer.from(`:${vlcPassword}`).toString('base64')}` } }).then(response => response.body?.cancel()).catch(() => {})
  try {
    await check('a_mpv_watch_state', async () => {
      const started = Date.now()
      const facts = await waitFor(tool, value => value.status === 'watching' && value.playback === 'playing')
      return { firstStateMs: Date.now() - started, site: facts.site, player: facts.player, title: facts.title, episode: facts.episode }
    })
    await check('b_mpv_dialogue_and_signs', async () => {
      const line = await waitFor(tool, value => value.dialogue?.text === 'Where are we going?', 8000)
      const japanese = await waitFor(tool, value => typeof value.dialogue?.text === 'string' && value.dialogue.text.includes('\n'), 8000)
      const unit = watch.unit()!
      return { first: line.dialogue, multiLine: japanese.dialogue.text, signShown: String(unit.message.content).includes('Bakery'), header: String(unit.message.content).split('\n')[0].slice(0, 90), bytes: Buffer.byteLength(String(unit.message.content)) }
    })
    await check('c_mpv_pause_latency', async () => {
      const sent = Date.now()
      mpvCommand('set_property', 'pause', true)
      await waitFor(tool, value => value.playback === 'paused', 5000)
      const latency = Date.now() - sent
      mpvCommand('set_property', 'pause', false)
      await waitFor(tool, value => value.playback === 'playing', 5000)
      return { pauseToStateMs: latency, dialogue_state_paused: 'gap' }
    })
    await check('d_vlc_second_player_stays_inactive', async () => {
      vlc = spawn(values.vlc!, ['-I', 'dummy', '--dummy-quiet', '--extraintf=http', '--http-host=127.0.0.1', `--http-port=${vlcPort}`, `--http-password=${vlcPassword}`, '--no-media-library', '--vout=dummy', '--aout=dummy', values.other!], { stdio: 'ignore', windowsHide: true })
      const players = await waitFor(() => ops().sources.players as Array<Record<string, any>>, value => value.some(player => player.kind === 'vlc' && player.playing === true), 20_000)
      return { active: tool().player, vlcActive: players.find(player => player.kind === 'vlc')?.active, adapters: (ops().sources.adapters as Array<Record<string, any>>).map(adapter => ({ adapter: adapter.adapter, connection: adapter.connection, limitations: adapter.limitations })) }
    })
    await check('e_takeover_when_mpv_pauses', async () => {
      const sent = Date.now()
      mpvCommand('set_property', 'pause', true)
      const facts = await waitFor(tool, value => value.player === 'vlc', 8000)
      return { switchMs: Date.now() - sent, title: facts.title, episode: facts.episode, ended: ops().counters.sessionsEnded }
    })
    await check('f_manual_selection', async () => {
      const mpvKey = (ops().sources.players as Array<Record<string, any>>).find(player => player.kind === 'mpv')!.key
      const sent = Date.now()
      const result = watch.selectSource(mpvKey)
      const facts = await waitFor(tool, value => value.player === 'mpv', 3000)
      const automatic = watch.selectSource(undefined)
      return { result, switchMs: Date.now() - sent, title: facts.title, automatic, manual: ops().sources.manualSelection ?? null }
    })
    await check('g_player_exit', async () => {
      mpvCommand('quit')
      const players = await waitFor(() => ops().sources.players as Array<Record<string, any>>, value => !value.some(player => player.kind === 'mpv'), 8000)
      await vlcCommand('command=pl_stop')
      await waitFor(() => ops().sources.players as Array<Record<string, any>>, value => value.length === 0, 8000)
      return { remainingAfterMpvQuit: players.map(player => player.kind), status: tool().status, ended: ops().counters.sessionsEnded, rejected: ops().counters.rejected }
    })
  }
  finally {
    results.reports = reports
    control.destroy()
    mpv.kill()
    vlc?.kill()
    await watch.shutdown()
    await gateway.close()
    await companion.close()
    await channel.stop?.()
  }
  await mkdir(dirname(values.out), { recursive: true })
  await writeFile(values.out, `${JSON.stringify(results, null, 2)}\n`, 'utf8')
  process.exit(0)
}

main().catch((error: unknown) => {
  console.error(errorMessageFrom(error) ?? 'live-local failed')
  process.exit(1)
})
