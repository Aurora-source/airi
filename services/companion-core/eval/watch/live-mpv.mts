#!/usr/bin/env tsx
import type { Socket } from 'node:net'

import type { PlayerObservation } from '../../src/watch/sources'

import process from 'node:process'

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'

import { errorMessageFrom } from '@moeru/std'

import { MpvAdapter } from '../../src/companion/sources/mpv'

/**
 * Plays a local fixture in the real mpv and follows it with {@link MpvAdapter}. A separate test-only IPC client changes
 * pause, position, subtitle track, and delay, so the probe can measure how fast each change reaches the adapter.
 * The Core never sends such commands. Only this probe does, to drive the player.
 *
 * Usage: tsx eval/watch/live-mpv.mts --mpv <mpv.exe> --file <video> --out <report.json> [--player jellyfin-media-player]
 *
 * Call stack:
 *
 * main
 *   -> spawn mpv --input-ipc-server
 *   -> {@link MpvAdapter.start} -> observations
 *   -> control client: set pause, seek, set sid, set sub-delay
 */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { mpv: { type: 'string' }, file: { type: 'string' }, out: { type: 'string' }, window: { type: 'boolean' } } })
  if (!values.mpv || !values.file || !values.out)
    throw new Error('Usage: live-mpv.mts --mpv <mpv.exe> --file <video> --out <report.json>')
  const pipe = `airi-live-${randomUUID().slice(0, 8)}`
  const started = Date.now()
  const log: Array<{ at: number, kind: string, detail: Record<string, unknown> }> = []
  const observations: Array<{ at: number, observation: PlayerObservation }> = []
  const record = (kind: string, detail: Record<string, unknown> = {}) => log.push({ at: Date.now() - started, kind, detail })

  const adapter = new MpvAdapter({ endpoints: [{ pipe, player: 'mpv' }], now: Date.now, heartbeatMs: 5000, retryMs: 200, maxRetryMs: 1000, report: message => record('report', { message }) })
  adapter.start({
    observe: (observation) => {
      observations.push({ at: Date.now(), observation })
      const update = observation.update
      if (update.kind === 'video')
        record('video', { playing: update.playing, position: update.position, timeline: update.stamp.timeline, session: update.stamp.session, ended: update.ended, title: update.media.title?.value, episode: update.media.episode?.value, captions: update.captions })
      else
        record('subtitle', { text: update.text, language: update.language, start_ms: update.start_ms, end_ms: update.end_ms, cleared: update.cleared, secondary: update.secondary, timeline: update.stamp.timeline })
    },
    gone: (key, reason) => record('gone', { key, reason }),
  })

  const args = ['--no-config', `--input-ipc-server=\\\\.\\pipe\\${pipe}`, '--sid=1', '--ao=null', '--keep-open=no', '--really-quiet']
  if (!values.window)
    args.push('--vo=null')
  const player = spawn(values.mpv, [...args, values.file], { stdio: 'ignore', windowsHide: !values.window })
  record('spawned', { pid: player.pid })

  const control = await openControl(pipe)
  const command = (...words: unknown[]) => control.write(`${JSON.stringify({ command: words })}\n`)
  const waitFor = async (check: () => boolean, ms: number) => {
    const deadline = Date.now() + ms
    while (!check() && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 5))
    return check()
  }
  const lastVideo = () => [...observations].reverse().find(item => item.observation.update.kind === 'video')
  const latencies: Record<string, number | null> = {}

  await waitFor(() => observations.length > 0, 5000)
  await new Promise(resolve => setTimeout(resolve, 5500))

  let sent = Date.now()
  command('set_property', 'pause', true)
  latencies.pause = await waitFor(() => lastVideo()?.observation.update.kind === 'video' && (lastVideo()!.observation.update as { playing?: boolean }).playing === false && lastVideo()!.at >= sent, 3000) ? lastVideo()!.at - sent : null
  await new Promise(resolve => setTimeout(resolve, 1000))
  sent = Date.now()
  command('set_property', 'pause', false)
  latencies.resume = await waitFor(() => (lastVideo()?.observation.update as { playing?: boolean }).playing === true && lastVideo()!.at >= sent, 3000) ? lastVideo()!.at - sent : null

  const timelineBefore = lastVideo()!.observation.update.stamp.timeline
  sent = Date.now()
  command('seek', 11.5, 'absolute')
  latencies.seek = await waitFor(() => lastVideo()!.observation.update.stamp.timeline > timelineBefore && lastVideo()!.at >= sent, 3000) ? lastVideo()!.at - sent : null

  await new Promise(resolve => setTimeout(resolve, 3000))
  sent = Date.now()
  command('set_property', 'sid', 2)
  latencies.trackSwitch = await waitFor(() => (lastVideo()?.observation.update as { captions?: { language?: string } }).captions?.language === 'ja' && lastVideo()!.at >= sent, 3000) ? lastVideo()!.at - sent : null
  command('seek', 15.5, 'absolute')
  await new Promise(resolve => setTimeout(resolve, 4000))
  command('set_property', 'sid', 1)
  command('set_property', 'sub-delay', 0.5)
  await new Promise(resolve => setTimeout(resolve, 1500))
  record('waiting-for-end')
  await waitFor(() => log.some(entry => entry.kind === 'gone'), 20_000)

  control.destroy()
  await new Promise(resolve => setTimeout(resolve, 300))
  player.kill()
  await adapter.stop()
  const report = { pipe, player: values.mpv, file: values.file.split(/[\\/]/).pop(), latencies, status: adapter.status(), log }
  await mkdir(dirname(values.out), { recursive: true })
  await writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.info(JSON.stringify({ latencies, videos: log.filter(entry => entry.kind === 'video').length, subtitles: log.filter(entry => entry.kind === 'subtitle').length, gone: log.filter(entry => entry.kind === 'gone').map(entry => entry.detail.reason) }))
}

async function openControl(pipe: string): Promise<Socket> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const socket = connect(`\\\\.\\pipe\\${pipe}`)
        socket.once('connect', () => resolve(socket))
        socket.once('error', reject)
      })
    }
    catch {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  throw new Error('mpv pipe did not open')
}

main().catch((error: unknown) => {
  console.error(errorMessageFrom(error) ?? 'live-mpv failed')
  process.exitCode = 1
})
