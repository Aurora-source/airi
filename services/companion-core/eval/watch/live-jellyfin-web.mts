#!/usr/bin/env tsx
import type { Page } from 'playwright'

import process from 'node:process'

import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { errorMessageFrom } from '@moeru/std'
import { createServer as createChannel } from '@proj-airi/server-runtime/server'
import { chromium } from 'playwright'

import { parseConfig, startGateway } from '../../src'
import { CompanionRuntime } from '../../src/companion/runtime'
import { createMediaSources, JellyfinClient, serverBase } from '../../src/companion/sources'
import { quickConnect } from '../../src/companion/sources/jellyfin-connect'

interface TestUsers {
  viewer: { name: string, password: string }
}

async function freePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  await new Promise(done => server.close(done))
  return typeof address === 'object' && address ? address.port : 0
}

async function waitFor<T>(read: () => T | Promise<T>, check: (value: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let value = await read()
  while (!check(value)) {
    if (Date.now() > deadline)
      throw new Error(`timed out: ${JSON.stringify(value).slice(0, 400)}`)
    await new Promise(done => setTimeout(done, 100))
    value = await read()
  }
  return value
}

/**
 * Live Jellyfin Web validation: the built AIRI extension in a real browser on the real jellyfin-web of a disposable
 * Jellyfin server, with the Companion Core following the same playback through the Sessions API.
 *
 * The probe signs in through the web client, allows the origin as Jellyfin in the extension settings, starts playback
 * with Jellyfin's own PlayNow remote command, and pauses and seeks the page's video element like a user.
 * The result holds states, numbers, and the synthetic fixture text only. Credentials come from a local file.
 *
 * Usage: tsx eval/watch/live-jellyfin-web.mts --extension <dir> --server <url> --users <file> --out <result.json> [--channel msedge]
 *
 * Call stack:
 *
 * main
 *   -> createChannel / CompanionRuntime.open (Jellyfin source) / startGateway
 *   -> launchPersistentContext (extension) -> jellyfin-web login
 *   -> Sessions/{id}/Playing PlayNow -> CompanionWatch.toolStatus checks
 */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { extension: { type: 'string' }, server: { type: 'string' }, users: { type: 'string' }, out: { type: 'string' }, channel: { type: 'string' }, headed: { type: 'boolean' } } })
  if (!values.extension || !values.server || !values.users || !values.out)
    throw new Error('Usage: live-jellyfin-web.mts --extension <dir> --server <url> --users <file> --out <result.json>')
  const extension = resolve(values.extension)
  const base = serverBase(values.server)
  const origin = base.origin
  const users = JSON.parse(await readFile(values.users, 'utf8')) as TestUsers
  const results: Record<string, unknown> = {}
  // Replaced once the watch runtime exists. A failed check stores what the runtime saw.
  let diagnostics = (): unknown => undefined
  const check = async (name: string, run: () => Promise<unknown>) => {
    const started = Date.now()
    try {
      results[name] = { ok: true, ms: Date.now() - started, detail: await run() }
    }
    catch (error) {
      results[name] = { ok: false, ms: Date.now() - started, error: errorMessageFrom(error) ?? 'unknown', diagnostics: diagnostics() }
    }
    console.info(name, JSON.stringify(results[name]).slice(0, 300))
  }
  const lookup = async () => [{ address: '127.0.0.1', family: 4 }]

  // Test-only helper client: signs in like an app and sends Jellyfin's own remote commands.
  const helperHeader = 'MediaBrowser Client="AIRI Probe", Device="probe", DeviceId="airi-probe-helper", Version="1.0"'
  const login = await fetch(new URL('Users/AuthenticateByName', base), { method: 'POST', headers: { 'Authorization': helperHeader, 'Content-Type': 'application/json' }, body: JSON.stringify({ Username: users.viewer.name, Pw: users.viewer.password }) }).then(response => response.json()) as { AccessToken: string, User: { Id: string }, ServerId: string }
  const helper = { header: `${helperHeader}, Token="${login.AccessToken}"` }
  const api = async (method: string, path: string, query: Record<string, string> = {}, body?: unknown) => {
    const url = new URL(path, base)
    for (const [key, value] of Object.entries(query))
      url.searchParams.set(key, value)
    const response = await fetch(url, { method, headers: { 'Authorization': helper.header, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await response.text()
    if (!response.ok)
      throw new Error(`${method} ${path} -> ${response.status}`)
    return text ? JSON.parse(text) : undefined
  }
  const episodes = (await api('GET', 'Items', { recursive: 'true', includeItemTypes: 'Episode', sortBy: 'IndexNumber' }) as { Items: Array<{ Id: string, IndexNumber: number }> }).Items
  const episode = (number: number) => episodes.find(item => item.IndexNumber === number)!.Id

  // The Core's token through Quick Connect, approved by the helper client of the same user.
  const token = (await quickConnect(new JellyfinClient({ base, hostname: 'probe-host', lookup }), {
    show: code => void api('POST', 'QuickConnect/Authorize', { code }),
    now: Date.now,
    sleep: ms => new Promise(done => setTimeout(done, ms)),
    intervalMs: 500,
  })).token

  const port = await freePort()
  const channel = createChannel({ hostname: '127.0.0.1', port })
  await channel.start()
  const home = mkdtempSync(join(tmpdir(), 'r6-jellyfin-web-'))
  const config = parseConfig({
    port: 0,
    store: { path: ':memory:' },
    channel: { url: `ws://127.0.0.1:${port}/ws` },
    memory: { path: join(home, 'memory.sqlite') },
    providers: { fake: { baseURL: 'http://127.0.0.1:9/v1/', keyRef: 'provider-fake' } },
    models: { 'fake-model': { provider: 'fake', model: 'none', capabilities: { contextWindow: 32_000 } } },
    aliases: { 'companion-chat': { chain: ['fake-model'] } },
    watch: { sources: { jellyfin: { enabled: true, url: values.server, followThisComputer: false } } },
  })
  const reports: string[] = []
  const mediaSources = createMediaSources(config.watch.sources, { jellyfinToken: token }, { now: Date.now, hostname: 'probe-host', lookup, report: line => reports.push(line) })
  const companion = await CompanionRuntime.open({ config, home, channel: true, report: line => reports.push(line), mediaSources })
  const gateway = await startGateway({ config, credentials: { inference: 'cc_inf_live-probe-inference-token-000000000000', ops: 'cc_ops_live-probe-ops-token-0000000000000000' }, providerKeys: new Map(), companion, writeLog: () => {} })
  companion.attach(gateway.runtime)
  const watch = companion.watch!
  const tool = () => watch.toolStatus() as Record<string, any>
  const ops = () => watch.status() as Record<string, any>
  diagnostics = () => {
    const status = ops()
    return { started: status.counters.sessionsStarted, ended: status.counters.sessionsEnded, rejected: status.counters.rejected, events: status.recentEvents.map((event: { kind: string }) => event.kind), group: status.sources.group, players: status.sources.players.map((player: Record<string, unknown>) => ({ kind: player.kind, reach: player.reach, eligible: player.eligible, group: player.group, playing: player.playing, lastSeenMs: player.lastSeenMs })), cueLookups: status.sources.adapters[0]?.details?.cueLookups, dialogue: (watch.toolStatus() as Record<string, any>).dialogue_state }
  }

  const userData = mkdtempSync(join(tmpdir(), 'r6-jellyfin-browser-'))
  const context = await chromium.launchPersistentContext(userData, {
    channel: values.channel,
    headless: !values.headed,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--autoplay-policy=no-user-gesture-required'],
  })
  results.browser = context.browser()?.version() ?? values.channel
  let page: Page | undefined
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
    await worker.evaluate(`chrome.storage.local.set(${JSON.stringify({ 'airi:web-extension:settings': { wsUrl: `ws://127.0.0.1:${port}/ws`, token: '', enabled: true, sendPageContext: true, sendVideoContext: true, sendSubtitles: true, sendSparkNotify: false, enableVision: false, jellyfinOrigins: [origin] } })})`)
    page = await context.newPage()
    const video = (script: string) => page!.evaluate(`(async () => { const v = document.querySelector('video.htmlvideoplayer') || document.querySelector('video'); ${script} })()`)

    await check('a_sign_in', async () => {
      await page!.goto(`${origin}/web/#/login`)
      // The login page lists users first. Manual login shows the name field.
      await page!.waitForSelector('#txtManualName, .btnManual', { timeout: 30_000 })
      if (await page!.$('.btnManual:visible'))
        await page!.click('.btnManual')
      await page!.fill('#txtManualName', users.viewer.name)
      await page!.fill('#txtManualPassword', users.viewer.password)
      await page!.click('.manualLoginForm .button-submit, .manualLoginForm button[type=submit]')
      await page!.waitForURL(url => !url.hash.includes('login'), { timeout: 30_000 })
      const deviceId = await page!.evaluate(`localStorage.getItem('_deviceId2')`)
      return { signedIn: true, deviceId: typeof deviceId === 'string' && deviceId.length > 0 }
    })

    const webSession = async () => {
      const deviceId = await page!.evaluate(`localStorage.getItem('_deviceId2')`) as string
      const sessions = await api('GET', 'Sessions', { deviceId }) as Array<{ Id: string, SupportsRemoteControl: boolean }>
      return sessions.find(session => session.SupportsRemoteControl)
    }

    await check('b_play_ass_episode_server_cues', async () => {
      const session = await waitFor(webSession, value => Boolean(value), 20_000)
      const sent = Date.now()
      await api('POST', `Sessions/${session!.Id}/Playing`, { playCommand: 'PlayNow', itemIds: episode(3), startPositionTicks: '0', subtitleStreamIndex: '2', audioStreamIndex: '1' })
      const facts = await waitFor(tool, value => value.status === 'watching' && value.playback === 'playing', 40_000)
      const firstAt = Date.now() - sent
      const cue = await waitFor(tool, value => value.dialogue?.source === 'subtitle', 30_000)
      const group = ops().sources.group
      return { firstStateMs: firstAt, site: facts.site, player: facts.player, title: facts.title, season: facts.season, episode: facts.episode, playbackSource: ops().session.playbackSource, groupMembers: group?.members?.length, dialogue: cue.dialogue, dialogueFrom: String(group?.dialogue ?? '').split(':')[0], captions: ops().session.captions }
    })

    await check('c_pause_from_page', async () => {
      const sent = Date.now()
      await video('v.pause()')
      await waitFor(tool, value => value.playback === 'paused', 10_000)
      return { latencyMs: Date.now() - sent, dialogue_state: tool().dialogue_state }
    })

    await check('d_resume_and_seek', async () => {
      await video('await v.play()')
      await waitFor(tool, value => value.playback === 'playing', 10_000)
      const revision = ops().session.revision
      const sent = Date.now()
      await video('v.currentTime = 15.5')
      const after = await waitFor(ops, value => value.session?.revision > revision, 10_000)
      const position = await waitFor(tool, value => value.position?.seconds >= 15, 10_000)
      return { latencyMs: Date.now() - sent, revisionBefore: revision, revisionAfter: after.session.revision, position: position.position.seconds }
    })

    await check('e_next_episode_text_subtitles', async () => {
      const session = await webSession()
      const before = ops().counters.sessionsStarted
      const sent = Date.now()
      // The embedded SubRip stream is a text track, so the page shows its text itself.
      const streams = (await api('GET', `Items/${episode(4)}`) as { MediaStreams: Array<{ Index: number, Type: string, Codec?: string, IsExternal?: boolean }> }).MediaStreams
      const srt = streams.find(stream => stream.Type === 'Subtitle' && stream.Codec === 'subrip' && !stream.IsExternal)!
      await api('POST', `Sessions/${session!.Id}/Playing`, { playCommand: 'PlayNow', itemIds: episode(4), startPositionTicks: '0', subtitleStreamIndex: String(srt.Index), audioStreamIndex: '1' })
      const facts = await waitFor(tool, value => value.episode?.number === 4 && value.playback === 'playing', 40_000)
      const latency = Date.now() - sent
      // Jellyfin's own remote command switches the page to the SubRip track, like the subtitle menu does.
      const revision = ops().session.revision
      await api('POST', `Sessions/${session!.Id}/Command`, {}, { Name: 'SetSubtitleStreamIndex', Arguments: { Index: String(srt.Index) } })
      const line = await waitFor(tool, value => value.episode?.number === 4 && value.dialogue?.source === 'subtitle' && /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(value.dialogue.text), 30_000)
      const switched = ops().session.revision > revision
      const group = ops().sources.group
      return { latencyMs: latency, episode: facts.episode, sessionsStartedDelta: ops().counters.sessionsStarted - before, dialogue: line.dialogue, dialogueFrom: String(group?.dialogue ?? '').split(':')[0], trackSwitchRevokedEvidence: switched, captions: ops().session.captions, events: ops().recentEvents.map((event: { kind: string }) => event.kind) }
    })

    await check('f_stop', async () => {
      const session = await webSession()
      await api('POST', `Sessions/${session!.Id}/Playing/Stop`)
      await waitFor(tool, value => value.status !== 'watching', 40_000)
      return { status: tool().status, ended: ops().counters.sessionsEnded }
    })
  }
  finally {
    results.players = (ops().sources?.players ?? []).map((player: Record<string, unknown>) => ({ key: String(player.key).replace(/:[^:]+$/, ':*'), kind: player.kind, reach: player.reach, eligible: player.eligible }))
    results.adapters = ops().sources?.adapters
    results.reports = reports
    await context.close()
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
  console.error(errorMessageFrom(error) ?? 'live-jellyfin-web failed')
  process.exit(1)
})
