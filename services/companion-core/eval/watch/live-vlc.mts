#!/usr/bin/env tsx
import type { PlayerObservation } from '../../src/watch/sources'

import process from 'node:process'

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'

import { errorMessageFrom } from '@moeru/std'

import { VlcAdapter } from '../../src/companion/sources/vlc'

/**
 * Plays a fixture in the real VLC with its HTTP interface on 127.0.0.1 and follows it with {@link VlcAdapter}.
 * VLC runs with the dummy interface and command-line options only, so the user's VLC settings and recent list stay
 * unchanged. This probe sends pause and seek commands to VLC itself. The adapter never sends a command.
 *
 * Usage: tsx eval/watch/live-vlc.mts --vlc <vlc.exe> --file <video> --out <report.json>
 *
 * Call stack:
 *
 * main
 *   -> spawn vlc -I dummy --extraintf=http --http-host=127.0.0.1
 *   -> {@link VlcAdapter.start} -> observations
 *   -> probe control: pl_pause, seek
 */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { vlc: { type: 'string' }, file: { type: 'string' }, out: { type: 'string' } } })
  if (!values.vlc || !values.file || !values.out)
    throw new Error('Usage: live-vlc.mts --vlc <vlc.exe> --file <video> --out <report.json>')
  const port = await freePort()
  const password = randomBytes(12).toString('base64url')
  const started = Date.now()
  const log: Array<{ at: number, kind: string, detail: Record<string, unknown> }> = []
  const observations: Array<{ at: number, observation: PlayerObservation }> = []
  const record = (kind: string, detail: Record<string, unknown> = {}) => log.push({ at: Date.now() - started, kind, detail })

  const adapter = new VlcAdapter({ port, password, now: Date.now, report: message => record('report', { message }) })
  adapter.start({
    observe: (observation) => {
      observations.push({ at: Date.now(), observation })
      const update = observation.update
      if (update.kind === 'video')
        record('video', { playing: update.playing, position: update.position, duration: update.duration, timeline: update.stamp.timeline, session: update.stamp.session, title: update.media.title?.value, episode: update.media.episode?.value, captions: update.captions })
    },
    gone: (key, reason) => record('gone', { key, reason }),
  })

  const player = spawn(values.vlc, ['-I', 'dummy', '--dummy-quiet', '--extraintf=http', '--http-host=127.0.0.1', `--http-port=${port}`, `--http-password=${password}`, '--no-media-library', '--vout=dummy', '--aout=dummy', '--play-and-exit', '--no-video-title-show', values.file], { stdio: 'ignore', windowsHide: true })
  record('spawned', { pid: player.pid })
  const control = async (query: string) => {
    await fetch(`http://127.0.0.1:${port}/requests/status.json?${query}`, { headers: { Authorization: `Basic ${Buffer.from(`:${password}`).toString('base64')}` } }).then(response => response.body?.cancel()).catch(() => {})
  }
  const waitFor = async (check: () => boolean, ms: number) => {
    const deadline = Date.now() + ms
    while (!check() && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 10))
    return check()
  }
  const last = () => observations.at(-1)
  const latencies: Record<string, number | null> = {}

  latencies.firstObservation = await waitFor(() => observations.length > 0, 15_000) ? observations[0].at - started : null
  await new Promise(resolve => setTimeout(resolve, 4000))
  let sent = Date.now()
  await control('command=pl_pause')
  latencies.pause = await waitFor(() => (last()?.observation.update as { playing?: boolean } | undefined)?.playing === false && last()!.at >= sent, 5000) ? last()!.at - sent : null
  await new Promise(resolve => setTimeout(resolve, 1500))
  sent = Date.now()
  await control('command=pl_pause')
  latencies.resume = await waitFor(() => (last()?.observation.update as { playing?: boolean } | undefined)?.playing === true && last()!.at >= sent, 5000) ? last()!.at - sent : null
  const timeline = last()!.observation.update.stamp.timeline
  sent = Date.now()
  await control('command=seek&val=18')
  latencies.seek = await waitFor(() => last()!.observation.update.stamp.timeline > timeline && last()!.at >= sent, 5000) ? last()!.at - sent : null
  record('waiting-for-end')
  await waitFor(() => log.some(entry => entry.kind === 'gone'), 20_000)
  const status = adapter.status()
  await adapter.stop()
  player.kill()
  const report = { port, file: values.file.split(/[\\/]/).pop(), latencies, status, log }
  await mkdir(dirname(values.out), { recursive: true })
  await writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.info(JSON.stringify({ latencies, videos: observations.length, gone: log.filter(entry => entry.kind === 'gone').map(entry => entry.detail.reason), version: status.details?.version }))
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port')))
    })
  })
}

main().catch((error: unknown) => {
  console.error(errorMessageFrom(error) ?? 'live-vlc failed')
  process.exitCode = 1
})
