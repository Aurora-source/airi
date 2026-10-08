#!/usr/bin/env tsx
import type { Route } from 'playwright'

import process from 'node:process'

import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { errorMessageFrom } from '@moeru/std'
import { createServer as createChannel } from '@proj-airi/server-runtime/server'
import { chromium } from 'playwright'

import { parseConfig, startGateway } from '../../src'
import { CompanionRuntime } from '../../src/companion/runtime'

/** The synthetic English page. Its title carries an explicit episode label. */
const EN_TITLE = 'R6 Synthetic Episode 2'
/** The synthetic Japanese page, with overlay captions only. */
const JA_TITLE = 'R6 合成テスト 第3話'
/** A public Creative Commons video for the one live attempt. */
const LIVE_URL = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'

const CUES = Array.from({ length: 12 }, (_, i) => {
  const start = 1 + i * 5
  const time = (seconds: number) => `00:00:${String(seconds).padStart(2, '0')}.000`
  return `${time(start)} --> ${time(start + 2)}\nSynthetic line ${i + 1}.`
}).join('\n\n')

const EN_PAGE = `<html><head><title>${EN_TITLE} - YouTube</title></head><body>
<ytd-watch-metadata><h1><yt-formatted-string id="title">${EN_TITLE}</yt-formatted-string></h1></ytd-watch-metadata>
<video id="player" muted src="/r6/media.webm"><track kind="captions" srclang="en" label="English" src="/r6/captions.vtt" default></video>
</body></html>`

const JA_PAGE = `<html><head><meta charset="utf-8"><title>${JA_TITLE} - YouTube</title></head><body>
<ytd-watch-metadata><h1><yt-formatted-string>${JA_TITLE}</yt-formatted-string></h1></ytd-watch-metadata>
<video id="player" muted src="/r6/media.webm"></video>
<div class="caption-window"><span class="ytp-caption-segment"></span></div>
<script>
  const lines = ['一緒に見よう。', 'ここは静かだね。', '次はどうなるの？']
  let index = 0
  setInterval(() => {
    const segment = document.querySelector('.ytp-caption-segment')
    segment.textContent = segment.textContent ? '' : lines[index++ % lines.length]
  }, 2500)
</script>
</body></html>`

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
      throw new Error(`timed out: ${JSON.stringify(value).slice(0, 300)}`)
    await new Promise(done => setTimeout(done, 100))
    value = read()
  }
  return value
}

/**
 * Practical Watch Together validation with the built browser extension.
 *
 * It starts AIRI's server channel and the Companion Core in this process, loads the extension into Chromium, and plays
 * synthetic pages that the request router serves under youtube.com. One live YouTube page is tried at the end.
 * The result file holds states, numbers, and the synthetic titles only.
 *
 * Usage: tsx eval/watch/live-extension.mts <extension dir> <media.webm> <result.json>
 * Set CHROMIUM_PATH to a Chromium executable when Playwright's own build is missing.
 *
 * Call stack:
 *
 * main
 *   -> createChannel (@proj-airi/server-runtime/server) / CompanionRuntime.open / startGateway
 *   -> chromium.launchPersistentContext (extension loaded)
 *     -> CompanionWatch.toolStatus / CompanionWatch.status checks
 */
async function main(): Promise<void> {
  const [extensionDirectory, mediaPath, resultPath] = process.argv.slice(2).map(value => resolve(value))
  const media = await readFile(mediaPath)
  const results: Record<string, unknown> = {}
  const check = async (name: string, run: () => Promise<unknown>) => {
    const started = Date.now()
    try {
      const detail = await run()
      results[name] = { ok: true, ms: Date.now() - started, detail }
    }
    catch (error) {
      results[name] = { ok: false, ms: Date.now() - started, error: errorMessageFrom(error) ?? 'unknown' }
    }
  }

  const port = await freePort()
  const channel = createChannel({ hostname: '127.0.0.1', port })
  await channel.start()
  const home = mkdtempSync(join(tmpdir(), 'r6-live-'))
  const config = parseConfig({
    port: 0,
    store: { path: ':memory:' },
    channel: { url: `ws://127.0.0.1:${port}/ws` },
    memory: { path: join(home, 'memory.sqlite') },
    providers: { fake: { baseURL: 'http://127.0.0.1:9/v1/', keyRef: 'provider-fake' } },
    models: { 'fake-model': { provider: 'fake', model: 'none', capabilities: { contextWindow: 32_000 } } },
    aliases: { 'companion-chat': { chain: ['fake-model'] } },
  })
  const reports: string[] = []
  const companion = await CompanionRuntime.open({ config, home, channel: true, report: line => reports.push(line) })
  const gateway = await startGateway({ config, credentials: { inference: 'cc_inf_live-probe-inference-token-000000000000', ops: 'cc_ops_live-probe-ops-token-0000000000000000' }, providerKeys: new Map(), companion, writeLog: () => {} })
  companion.attach(gateway.runtime)
  const watch = companion.watch!
  const tool = () => watch.toolStatus() as Record<string, any>
  const ops = () => watch.status() as Record<string, any>

  const userData = mkdtempSync(join(tmpdir(), 'r6-chromium-'))
  const context = await chromium.launchPersistentContext(userData, {
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
    args: [`--disable-extensions-except=${extensionDirectory}`, `--load-extension=${extensionDirectory}`, '--autoplay-policy=no-user-gesture-required'],
  })
  results.chromium = context.browser()?.version()

  // Media requests ask for byte ranges, so seeking needs 206 answers.
  const serveMedia = async (route: Route) => {
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '')
    if (!range)
      return route.fulfill({ status: 200, contentType: 'video/webm', headers: { 'accept-ranges': 'bytes' }, body: media })
    const start = Number(range[1])
    const end = range[2] ? Math.min(Number(range[2]), media.length - 1) : media.length - 1
    return route.fulfill({ status: 206, contentType: 'video/webm', headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${media.length}` }, body: media.subarray(start, end + 1) })
  }
  await context.route(url => url.hostname === 'www.youtube.com' && (url.pathname.startsWith('/r6/') || url.searchParams.get('v')?.startsWith('r6-') === true), async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/r6/media.webm')
      return serveMedia(route)
    if (url.pathname === '/r6/captions.vtt')
      return route.fulfill({ contentType: 'text/vtt', body: `WEBVTT\n\n${CUES}\n` })
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: url.searchParams.get('v') === 'r6-ja' ? JA_PAGE : EN_PAGE })
  })

  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
    // The popup writes the same settings. The background reconnects when they change.
    await worker.evaluate(`chrome.storage.local.set(${JSON.stringify({ 'airi:web-extension:settings': { wsUrl: `ws://127.0.0.1:${port}/ws`, token: '', enabled: true, sendPageContext: true, sendVideoContext: true, sendSubtitles: true, sendSparkNotify: false, enableVision: false } })})`)
    const page = await context.newPage()
    const player = (script: string) => page.evaluate(`(async () => { const v = document.getElementById('player'); ${script} })()`)

    await check('a_video_to_fresh_state', async () => {
      await page.goto('https://www.youtube.com/watch?v=r6-en')
      await player('await v.play()')
      const facts = await waitFor(tool, value => value.status === 'watching' && value.playback === 'playing')
      return { title: facts.title, episode: facts.episode, site: facts.site, playback: facts.playback }
    })
    await check('b_caption_progression', async () => {
      const first = await waitFor(tool, value => value.dialogue?.source === 'subtitle')
      const second = await waitFor(tool, value => value.dialogue?.source === 'subtitle' && value.dialogue.text !== first.dialogue.text, 12_000)
      return { first: first.dialogue.text, second: second.dialogue.text, language: second.dialogue.language, accepted: ops().counters.accepted }
    })
    await check('c_timed_gap', async () => {
      const gap = await waitFor(tool, value => value.dialogue_state === 'gap', 12_000)
      return { dialogue_state: gap.dialogue_state }
    })
    await check('d_pause_and_reaction', async () => {
      await player('v.pause()')
      await waitFor(tool, value => value.playback === 'paused')
      const offered = watch.offerReaction({ kind: 'pause', observation_key: 'live-probe-pause', salience: 0.9 })
      const status = await waitFor(ops, value => value.session?.reaction?.last?.outcome === 'delivered', 6000)
      return { offered, outcome: status.session.reaction.last.outcome, cooldownMs: status.session.reaction.cooldownRemainingMs }
    })
    await check('e_resume', async () => {
      await player('await v.play()')
      await waitFor(tool, value => value.playback === 'playing')
      return { events: ops().recentEvents.map((event: { kind: string }) => event.kind) }
    })
    await check('f_seek_new_timeline', async () => {
      const before = ops().session.revision
      await player('v.currentTime = 30')
      const after = await waitFor(ops, value => value.session?.revision > before)
      return { before, after: after.session.revision, position: (await waitFor(tool, value => value.position?.seconds >= 29)).position.seconds }
    })
    await check('g_title_change', async () => {
      await page.evaluate(`document.getElementById('title').textContent = 'R6 Synthetic Episode 2 (renamed)'`)
      return (await waitFor(tool, value => value.title?.text === 'R6 Synthetic Episode 2 (renamed)', 8000)).title
    })
    await check('h_japanese_overlay_captions', async () => {
      await page.goto('https://www.youtube.com/watch?v=r6-ja')
      await player('await v.play()')
      const line = await waitFor(tool, value => value.title?.text === JA_TITLE && value.dialogue?.source === 'subtitle', 12_000)
      const cleared = await waitFor(tool, value => value.title?.text === JA_TITLE && !value.dialogue, 8000)
      return { episode: line.episode, line_is_japanese: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(line.dialogue.text), after_clear: cleared.dialogue_state }
    })
    await check('i_disconnect_reconnect', async () => {
      const first = ops().session.id
      await channel.stop()
      await waitFor(tool, value => value.status === 'idle', 10_000)
      await channel.start()
      const back = await waitFor(ops, value => value.session?.id && value.session.id !== first && value.session.status === 'watching', 30_000)
      return { new_session: back.session.id !== first, ended: back.counters.sessionsEnded }
    })
    await check('j_live_youtube', async () => {
      // The synthetic tab stops playing, so a playing live tab can take over the selection.
      await player('v.pause()')
      const live = await context.newPage()
      await live.goto(LIVE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await live.locator('video').first().waitFor({ timeout: 20_000 })
      await live.evaluate('document.querySelector("video")?.play().catch(() => {})')
      const facts = await waitFor(tool, value => value.status === 'watching' && value.site === 'youtube' && !String(value.title?.text ?? '').startsWith('R6'), 30_000)
      return { site: facts.site, title_present: Boolean(facts.title?.text), playback: facts.playback }
    })
    results.counters = ops().counters
    results.reports = reports.filter(line => !line.includes('channel error')).length
  }
  finally {
    await context.close()
    await companion.watch?.shutdown()
    await gateway.close()
    await companion.close()
    await channel.stop()
    rmSync(userData, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
  await writeFile(resultPath, `${JSON.stringify(results, null, 2)}\n`)
  console.info(JSON.stringify(Object.fromEntries(Object.entries(results).map(([name, value]) => [name, typeof value === 'object' && value && 'ok' in value ? value.ok : value]))))
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
