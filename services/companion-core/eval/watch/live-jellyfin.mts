#!/usr/bin/env tsx
import type { PlayerObservation } from '../../src/watch/sources'

import process from 'node:process'

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'

import { errorMessageFrom } from '@moeru/std'

import { JellyfinAdapter } from '../../src/companion/sources/jellyfin'
import { JellyfinClient } from '../../src/companion/sources/jellyfin-client'
import { quickConnect } from '../../src/companion/sources/jellyfin-connect'
import { serverBase } from '../../src/companion/sources/network'
import { MediaSourceManager } from '../../src/watch/source-manager'

interface TestUsers {
  admin: { name: string, password: string }
  viewer: { name: string, password: string }
  other: { name: string, password: string }
}

/**
 * Follows a real Jellyfin server with {@link JellyfinAdapter}. Test clients report playback through Jellyfin's own
 * playback API, the same calls that Jellyfin Web and Jellyfin Media Player make. The adapter gets its token through
 * the real Quick Connect flow, approved by the test viewer. Use a disposable test server only. Credentials come from
 * a local file and are never printed.
 *
 * Usage: tsx eval/watch/live-jellyfin.mts --server <url> --users <test-credentials.json> --out <report.json>
 *
 * Call stack:
 *
 * main
 *   -> quickConnect (approved by the viewer client) -> token
 *   -> {@link JellyfinAdapter.start} -> {@link MediaSourceManager.observe}
 *   -> test clients: Sessions/Playing, Progress (pause, seek), next item, Stopped
 *   -> JellyfinAdapter.followCues -> current cue of the ASS stream
 */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { server: { type: 'string' }, users: { type: 'string' }, out: { type: 'string' } } })
  if (!values.server || !values.users || !values.out)
    throw new Error('Usage: live-jellyfin.mts --server <url> --users <file> --out <report.json>')
  const base = serverBase(values.server)
  const users = JSON.parse(await readFile(values.users, 'utf8')) as TestUsers
  const started = Date.now()
  const log: Array<{ at: number, kind: string, detail: Record<string, unknown> }> = []
  const record = (kind: string, detail: Record<string, unknown> = {}) => log.push({ at: Date.now() - started, kind, detail })
  const lookup = async () => [{ address: '127.0.0.1', family: 4 }]
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

  // A test client logs in like a Jellyfin app: Client, Device, and DeviceId in the Authorization header.
  const login = async (user: { name: string, password: string }, client: string, device: string, deviceId: string) => {
    const header = `MediaBrowser Client="${client}", Device="${device}", DeviceId="${deviceId}", Version="1.0"`
    const response = await fetch(new URL('Users/AuthenticateByName', base), { method: 'POST', headers: { 'Authorization': header, 'Content-Type': 'application/json' }, body: JSON.stringify({ Username: user.name, Pw: user.password }) })
    if (!response.ok)
      throw new Error(`login ${client} -> ${response.status}`)
    const body = await response.json() as { AccessToken: string, User: { Id: string } }
    return { header: `${header}, Token="${body.AccessToken}"`, userId: body.User.Id }
  }
  const call = async (auth: { header: string }, method: string, path: string, body?: unknown, query: Record<string, string> = {}) => {
    const url = new URL(path, base)
    for (const [key, value] of Object.entries(query))
      url.searchParams.set(key, value)
    const response = await fetch(url, { method, headers: { 'Authorization': auth.header, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await response.text()
    if (!response.ok)
      throw new Error(`${method} ${path} -> ${response.status}`)
    return text ? JSON.parse(text) : undefined
  }

  const viewerApp = await login(users.viewer, 'Jellyfin Web', 'Probe Browser', 'probe-approver')
  const items = await call(viewerApp, 'GET', 'Items', undefined, { recursive: 'true', includeItemTypes: 'Episode', sortBy: 'IndexNumber' }) as { Items: Array<{ Id: string, IndexNumber: number }> }
  const [episode3, episode4] = [3, 4].map(number => items.Items.find(item => item.IndexNumber === number)!)

  // 1. Quick Connect: the Core asks for a code, the signed-in viewer approves it.
  const client = new JellyfinClient({ base, hostname: hostname(), lookup })
  let approvedAt = 0
  const connected = await quickConnect(client, {
    show: (code) => {
      record('quick-connect-code-shown')
      void call(viewerApp, 'POST', 'QuickConnect/Authorize', undefined, { code }).then(() => {
        approvedAt = Date.now()
        record('quick-connect-approved')
      })
    },
    now: Date.now,
    sleep,
    intervalMs: 500,
  })
  record('quick-connect-token', { user: connected.user, admin: connected.admin, tokenLength: connected.token.length, approvalToTokenMs: Date.now() - approvedAt })

  // 2. A refused token never reaches the user's sessions.
  const refused = new JellyfinAdapter({ base, token: 'ffffffffffffffffffffffffffffffff', now: Date.now, hostname: hostname(), lookup, followThisComputer: true, devices: [], serverSubtitles: false })
  refused.start({ observe: () => record('refused-token-observed'), gone: () => {} })
  await sleep(1500)
  record('refused-token-status', { connection: refused.status().connection, error: refused.status().error })
  await refused.stop()

  // 3. The adapter with the Quick Connect token, through the real source manager.
  const manager = new MediaSourceManager({ now: Date.now, staleMs: 120_000, takeoverMs: 35_000 })
  const observations: Array<{ at: number, observation: PlayerObservation }> = []
  const adapter = new JellyfinAdapter({ base, token: connected.token, now: Date.now, hostname: hostname(), lookup, followThisComputer: true, devices: [], serverSubtitles: true, pollMs: 1500, idlePollMs: 3000 })
  adapter.start({
    observe: (observation) => {
      observations.push({ at: Date.now(), observation })
      const update = observation.update
      if (update.kind === 'video') {
        record('video', { player: observation.player.key, kind: observation.player.kind, eligible: observation.player.eligible, links: observation.player.links.length, playing: update.playing, position: Math.round((update.position ?? 0) * 10) / 10, timeline: update.stamp.timeline, title: update.media.title?.value, season: update.media.season?.value, episode: update.media.episode?.value, captions: update.captions })
      }
      else {
        record('subtitle', { player: observation.player.key, text: update.text, start_ms: update.start_ms, end_ms: update.end_ms, cleared: update.cleared, sync: update.sync, timeline: update.stamp.timeline })
      }
      for (const output of manager.observe(observation))
        record(`manager-${output.kind}`, output.kind === 'update' ? { lane: output.update.kind, session: output.update.stamp.session, timeline: output.update.stamp.timeline } : { key: output.key })
    },
    gone: (key, reason) => {
      record('gone', { key, reason })
      for (const output of manager.gone(key, reason))
        record(`manager-${output.kind}`, { key: output.key })
    },
  })

  // Test clients: this computer's Jellyfin Media Player, a Jellyfin Web tab, and another user's TV.
  const jmp = await login(users.viewer, 'Jellyfin Media Player', hostname(), 'probe-jmp')
  const web = await login(users.viewer, 'Jellyfin Web', 'Chrome', 'probe-web')
  const otherTv = await login(users.other, 'Jellyfin Android TV', 'Other TV', 'probe-other-tv')
  const ticks = (seconds: number) => Math.round(seconds * 10_000_000)
  const report = (auth: { header: string }, path: string, item: string, seconds: number, extra: Record<string, unknown> = {}) => call(auth, 'POST', path, { ItemId: item, MediaSourceId: item, PositionTicks: ticks(seconds), IsPaused: false, CanSeek: true, PlayMethod: 'DirectPlay', SubtitleStreamIndex: 2, AudioStreamIndex: 1, PlaySessionId: `probe-${item}`, ...extra })

  await report(otherTv, 'Sessions/Playing', episode3.Id, 100)
  await report(web, 'Sessions/Playing', episode3.Id, 50, { SubtitleStreamIndex: -1 })
  const jmpStart = Date.now()
  // The simulated player clock starts at the play report, like a real client.
  const playStart = jmpStart - 500
  const position = () => (Date.now() - playStart) / 1000
  await report(jmp, 'Sessions/Playing', episode3.Id, position())
  const seen = (check: (entry: { at: number, observation: PlayerObservation }) => boolean, since: number) => observations.find(entry => entry.at >= since && check(entry))
  const waitFor = async (check: () => boolean, ms: number) => {
    const deadline = Date.now() + ms
    while (!check() && Date.now() < deadline)
      await sleep(20)
    return check()
  }
  const latency: Record<string, number | null> = {}
  const jmpVideo = (entry: { observation: PlayerObservation }) => entry.observation.player.key.startsWith('jellyfin:') && entry.observation.player.kind === 'jellyfin-media-player' && entry.observation.update.kind === 'video'
  latency.start = await waitFor(() => Boolean(seen(jmpVideo, jmpStart)), 8000) ? seen(jmpVideo, jmpStart)!.at - jmpStart : null

  // Cue window on the active group: the clock follows the simulated player.
  const cueTimer = setInterval(() => {
    const request = manager.cueRequest()
    adapter.followCues(request && { ...request, position })
  }, 200)
  for (let second = 1; second <= 8; second++) {
    await sleep(1000)
    await report(jmp, 'Sessions/Playing/Progress', episode3.Id, position(), { EventName: 'timeupdate' })
  }
  let sent = Date.now()
  await report(jmp, 'Sessions/Playing/Progress', episode3.Id, position(), { IsPaused: true, EventName: 'pause' })
  latency.pause = await waitFor(() => Boolean(seen(entry => jmpVideo(entry) && entry.observation.update.kind === 'video' && entry.observation.update.playing === false, sent)), 6000) ? seen(entry => jmpVideo(entry) && (entry.observation.update as { playing?: boolean }).playing === false, sent)!.at - sent : null
  await sleep(1500)
  sent = Date.now()
  await report(jmp, 'Sessions/Playing/Progress', episode3.Id, 20, { IsPaused: false, EventName: 'timeupdate' })
  latency.seek = await waitFor(() => Boolean(seen(entry => jmpVideo(entry) && entry.observation.update.stamp.timeline > 0, sent)), 6000) ? seen(entry => jmpVideo(entry) && entry.observation.update.stamp.timeline > 0, sent)!.at - sent : null
  clearInterval(cueTimer)
  adapter.followCues(undefined)

  sent = Date.now()
  await report(jmp, 'Sessions/Playing/Stopped', episode3.Id, 20)
  await report(jmp, 'Sessions/Playing', episode4.Id, 0, { SubtitleStreamIndex: 3 })
  latency.nextItem = await waitFor(() => Boolean(seen(entry => jmpVideo(entry) && entry.observation.update.kind === 'video' && entry.observation.update.media.episode?.value === 4, sent)), 8000) ? seen(entry => jmpVideo(entry) && (entry.observation.update as { media: { episode?: { value: number } } }).media.episode?.value === 4, sent)!.at - sent : null

  sent = Date.now()
  await report(jmp, 'Sessions/Playing/Stopped', episode4.Id, 3)
  latency.stopped = await waitFor(() => log.some(entry => entry.kind === 'gone' && entry.at >= sent - started && String(entry.detail.key).startsWith('jellyfin:')), 8000) ? Date.now() - sent : null
  await report(web, 'Sessions/Playing/Stopped', episode3.Id, 60)
  await report(otherTv, 'Sessions/Playing/Stopped', episode3.Id, 110)

  const status = adapter.status()
  await adapter.stop()
  const summary = {
    server: base.host,
    quickConnect: { user: connected.user, admin: connected.admin },
    latency,
    otherUserSeen: observations.some(entry => entry.observation.player.key.includes('other') || JSON.stringify(entry.observation).includes('Other TV')),
    webEligible: observations.find(entry => entry.observation.player.kind === 'jellyfin-web')?.observation.player.eligible,
    cues: log.filter(entry => entry.kind === 'subtitle').map(entry => entry.detail.text),
    managerStarts: log.filter(entry => entry.kind === 'manager-start').length,
    status,
  }
  await mkdir(dirname(values.out), { recursive: true })
  await writeFile(values.out, `${JSON.stringify({ summary, log }, null, 2)}\n`, 'utf8')
  console.info(JSON.stringify(summary))
}

main().catch((error: unknown) => {
  console.error(errorMessageFrom(error) ?? 'live-jellyfin failed')
  process.exitCode = 1
})
