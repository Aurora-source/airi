import assert from 'node:assert/strict'
import process from 'node:process'

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { chromium } from 'playwright'

/** Verify gallery comparison controls, pure native channels, and measured runtime cost. */
async function main() {
  const [avatar, output, url = 'http://127.0.0.1:5199/'] = process.argv.slice(2)
  assert.ok(avatar && output, 'Supply an absolute local avatar path and an evidence directory.')
  await mkdir(output, { recursive: true })
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 950 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(url)
    await page.getByTestId('corpus-files').setInputFiles(avatar)
    await page.waitForFunction(() => !!window.__airiVisualDemo?.snapshot().loaded)
    const viewport = page.getByTestId('avatar-viewport')
    await viewport.scrollIntoViewIfNeeded()
    const comparisons = []
    for (const enabled of [false, true]) {
      await page.evaluate(() => window.__airiVisualDemo.stop())
      await page.getByRole('checkbox', { name: 'Body gestures ON / OFF', exact: true }).setChecked(enabled)
      assert.equal(await page.evaluate(() => window.__airiVisualDemo.review('happy', 0.42)), 'started')
      const before = await page.evaluate(() => window.__airiVisualDemo.snapshot().frameCount)
      await page.waitForFunction(previous => window.__airiVisualDemo.snapshot().frameCount > previous + 2, before)
      const snapshot = await page.evaluate(() => window.__airiVisualDemo.snapshot())
      const body = Object.entries(snapshot.pose).filter(([axis, value]) => typeof value === 'number' && !axis.startsWith('head') && !axis.startsWith('gaze') && !['breath', 'expressionWeight'].includes(axis))
      assert.ok(enabled ? body.some(([, value]) => Math.abs(value) > 0.05) : body.every(([, value]) => value === 0))
      const screenshot = `body-${enabled ? 'on' : 'off'}.png`
      await viewport.screenshot({ path: join(output, screenshot) })
      comparisons.push({ enabled, screenshot, snapshot })
    }
    await page.evaluate(() => window.__airiVisualDemo.stop())
    const native = []
    for (const channel of ['blink', 'aa', 'ih', 'ou', 'ee', 'oh']) {
      const button = page.locator(`[data-native-expression="${channel}"]`)
      if (!await button.count())
        continue
      await button.click()
      await page.waitForFunction(name => window.__airiVisualDemo.expressionValue(name) >= 0.5, channel)
      const pose = await page.evaluate(() => window.__airiVisualDemo.snapshot().pose)
      assert.ok(Object.entries(pose).filter(([, value]) => typeof value === 'number').every(([, value]) => value === 0), 'Raw blink/mouth previews must never request body motion.')
      native.push(channel)
    }
    await page.getByRole('button', { name: 'Stop / cancel', exact: true }).click()
    const timings = await page.evaluate(async () => {
      const samples = []
      for (const id of ['stretch', 'thinking', 'happy', 'surprised']) {
        window.__airiVisualDemo.stop()
        const result = window.__airiVisualDemo.review(id, id === 'surprised' ? 0.14 : 0.42)
        const before = window.__airiVisualDemo.snapshot().frameCount
        const target = Math.ceil(before / 120) * 120 + 120
        const started = performance.now()
        await new Promise((resolve) => {
          function frame() {
            if (window.__airiVisualDemo.snapshot().frameCount >= target)
              resolve()
            else
              requestAnimationFrame(frame)
          }
          requestAnimationFrame(frame)
        })
        const snapshot = window.__airiVisualDemo.snapshot()
        samples.push({ id, result, active: snapshot.behavior, cpuMs: snapshot.cpuMs, frameIntervalMs: (performance.now() - started) / (snapshot.frameCount - before) })
      }
      return samples
    })
    assert.deepEqual(errors, [])
    assert.ok(timings.every(sample => sample.result === 'started' && sample.active === sample.id && Number.isFinite(sample.cpuMs) && sample.cpuMs < 0.5), 'The active visual pose hook should remain below half a millisecond per frame.')
    const result = { chromium: browser.version(), comparisons, native, timings, pageErrors: errors.length }
    await writeFile(join(output, 'controls.json'), `${JSON.stringify(result, null, 2)}\n`)
    console.info(JSON.stringify({ chromium: result.chromium, bodyComparison: true, native, timings, pageErrors: errors.length }))
  }
  finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
