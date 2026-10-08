import assert from 'node:assert/strict'
import process from 'node:process'

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { chromium } from 'playwright'

// The bundles and generated WebM stay outside Git. No media content enters the result log.
async function main() {
  const directory = resolve(process.argv[2])
  const upstream = await readFile(resolve(directory, 'upstream-content.js'), 'utf8')
  const watch = await readFile(resolve(directory, 'watch-runtime.js'), 'utf8')
  const fixture = await readFile(resolve(directory, 'synthetic.webm'))
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()

  async function install() {
    await page.addScriptTag({ content: watch })
    await page.evaluate(() => {
      const state = new window.R6Watch.WatchState({ now: () => Date.now() })
      state.connect(1)
      window.r6 = { state, sequence: 0, session: 1, timeline: 0, lastVideo: undefined, lastSubtitle: undefined, videoCount: 0, subtitleCount: 0 }
      window.browser = { runtime: {
        onMessage: { addListener() {} },
        sendMessage(message) {
          const r6 = window.r6
          const stamp = { session: r6.session, sequence: ++r6.sequence, observed_at: Date.now(), timeline: r6.timeline }
          if (message.type === 'content:video') {
            r6.lastVideo = message.payload
            r6.videoCount++
            const update = window.R6Watch.normalizeVideo(message.payload, stamp)
            if (update)
              r6.state.ingest(update)
          }
          if (message.type === 'content:subtitle') {
            r6.lastSubtitle = message.payload
            r6.subtitleCount++
            const update = window.R6Watch.normalizeSubtitle(message.payload, stamp)
            if (update)
              r6.state.ingest(update)
          }
          return Promise.resolve()
        },
      } }
    })
    await page.addScriptTag({ content: upstream })
    await page.evaluate(() => {
      window.stopUpstream = window.UpstreamMedia.startContentObserver()
    })
  }

  const results = { chromium: browser.version(), youtube: {}, synthetic: {} }
  try {
    try {
      await page.goto('https://www.youtube.com/watch?v=aqz-KE-bpKQ', { waitUntil: 'domcontentloaded', timeout: 20000 })
      await page.locator('video').waitFor({ timeout: 10000 })
      await install()
      await page.waitForFunction(() => window.r6.videoCount > 0, { timeout: 10000 })
      results.youtube = await page.evaluate(() => ({ video_present: true, metadata_received: window.r6.videoCount > 0, title_present: Boolean(window.r6.lastVideo?.title), media_normalized: Boolean(window.r6.state.current().media) }))
    }
    catch {
      results.youtube = { available: false, reason: 'live YouTube player unavailable in validation browser' }
    }

    await page.route('https://www.youtube.com/r6-synthetic.webm', route => route.fulfill({ contentType: 'video/webm', body: fixture }))
    await page.route('https://www.youtube.com/watch?v=r6-synthetic', route => route.fulfill({ contentType: 'text/html', body: '<html><title>Synthetic Episode 2</title><body><ytd-watch-metadata><h1><yt-formatted-string>Synthetic Episode 2</yt-formatted-string></h1></ytd-watch-metadata><video id="sample" muted controls src="/r6-synthetic.webm"></video></body></html>' }))
    await page.goto('https://www.youtube.com/watch?v=r6-synthetic')
    await page.evaluate(async () => {
      const video = document.querySelector('video')
      if (video.readyState < 1)
        await new Promise(resolve => video.addEventListener('loadedmetadata', resolve, { once: true }))
      const en = video.addTextTrack('subtitles', 'English', 'en')
      en.mode = 'hidden'
      for (let index = 0; index < 5; index++)
        en.addCue(new VTTCue(index * 0.3, index * 0.3 + 0.25, `Synthetic caption ${index}`))
      const ja = video.addTextTrack('subtitles', 'Japanese', 'ja')
      ja.mode = 'hidden'
      ja.addCue(new VTTCue(2, 3, '一緒に見よう。'))
    })
    await install()
    await page.evaluate(async () => {
      await document.querySelector('video').play()
    })
    await page.waitForFunction(() => window.r6.subtitleCount >= 3)
    results.synthetic.subtitle_progression = true
    results.synthetic.play = await page.evaluate(() => window.r6.state.current().playback?.value === 'playing')
    await page.waitForFunction(() => window.r6.state.current().dialogue?.language === 'ja')
    results.synthetic.japanese = await page.evaluate(() => window.r6.state.current().dialogue?.value === '一緒に見よう。')
    await page.waitForFunction(() => window.r6.state.current().dialogue_active === 'gap', { timeout: 8000 })
    results.synthetic.timed_subtitle_gap = true
    await page.evaluate(() => document.querySelector('video').pause())
    await page.waitForFunction(() => window.r6.state.current().playback?.value === 'paused')
    results.synthetic.pause = true
    await page.evaluate(async () => {
      const video = document.querySelector('video')
      video.currentTime = 7
      await video.play()
    })
    await page.waitForFunction(() => window.r6.state.current().position?.value >= 7)
    results.synthetic.resume_and_seek = await page.evaluate(() => window.r6.state.current().playback?.value === 'playing' && !window.r6.state.current().dialogue)
    results.synthetic.disconnect_reconnect = await page.evaluate(() => {
      const r6 = window.r6
      const old = window.R6Watch.normalizeVideo(r6.lastVideo, { session: 1, sequence: ++r6.sequence, observed_at: Date.now(), timeline: 0 })
      r6.state.disconnect()
      const disconnected = r6.state.current().status === 'idle'
      r6.state.connect(2)
      r6.session = 2
      const oldRejected = !r6.state.ingest(old)
      const current = window.R6Watch.normalizeVideo(r6.lastVideo, { session: 2, sequence: ++r6.sequence, observed_at: Date.now(), timeline: 0 })
      return disconnected && oldRejected && r6.state.ingest(current)
    })
    for (const value of Object.values(results.synthetic)) assert.equal(value, true)
    process.stdout.write(`${JSON.stringify(results)}\n`)
  }
  finally {
    await browser.close()
  }
}

main().catch(() => {
  process.stderr.write('R6 live browser validation failed\n')
  process.exitCode = 1
})
