import assert from 'node:assert/strict'
import process from 'node:process'

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { chromium } from 'playwright'

/**
 * Capture each catalog behavior through the real gallery and authored idle animation.
 *
 * Call stack:
 * main -> gallery file input -> runtime pose hook -> controller -> VRM adapter
 */
async function main() {
  const [avatar, output, url = 'http://127.0.0.1:5200/'] = process.argv.slice(2)
  assert.ok(avatar && output, 'Supply an absolute local avatar path and an evidence directory.')
  await mkdir(output, { recursive: true })
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 950 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(url)
    await page.getByTestId('corpus-files').setInputFiles(avatar)
    await page.waitForFunction(() => !!window.__airiVisualDemo?.snapshot().loaded, undefined, { timeout: 60000 })
    await page.evaluate(() => window.__airiVisualDemo.stop())
    const viewport = page.getByTestId('avatar-viewport')
    await viewport.scrollIntoViewIfNeeded()
    await viewport.screenshot({ path: join(output, 'neutral.png') })
    const behaviors = await page.evaluate(() => window.__airiVisualDemo.behaviors)
    const rows = []
    for (const behavior of behaviors) {
      await page.evaluate(() => window.__airiVisualDemo.stop())
      await viewport.scrollIntoViewIfNeeded()
      const started = Date.now()
      const samples = []
      for (const fraction of [0.18, 0.42, 0.77]) {
        assert.equal(await page.evaluate(({ id, fraction }) => window.__airiVisualDemo.review(id, fraction), { id: behavior.id, fraction }), 'started')
        const before = await page.evaluate(() => window.__airiVisualDemo.snapshot().frameCount)
        await page.waitForFunction(previous => window.__airiVisualDemo.snapshot().frameCount > previous + 2, before)
        const screenshot = `${behavior.id}-${Math.round(fraction * 100)}.png`
        await viewport.screenshot({ path: join(output, screenshot) })
        const data = await page.evaluate(() => ({ snapshot: window.__airiVisualDemo.snapshot(), bones: window.__airiVisualDemo.bones() }))
        assert.equal(data.snapshot.behavior, behavior.id, 'The captured pose must still own the review timeline.')
        for (const bone of Object.values(data.bones)) {
          assert.ok(bone.quaternion.every(Number.isFinite))
          assert.ok(bone.position.every(Number.isFinite))
        }
        samples.push({ fraction, elapsedMs: Date.now() - started, screenshot, ...data })
      }
      await page.evaluate(id => window.__airiVisualDemo.review(id, 1), behavior.id)
      const before = await page.evaluate(() => window.__airiVisualDemo.snapshot().frameCount)
      await page.waitForFunction(previous => window.__airiVisualDemo.snapshot().frameCount > previous + 2, before)
      const neutral = await page.evaluate(() => window.__airiVisualDemo.snapshot())
      assert.equal(neutral.behavior, undefined)
      assert.ok(Object.entries(neutral.pose).filter(([, value]) => typeof value === 'number').every(([, value]) => Math.abs(value) < 1e-8))
      rows.push({ ...behavior, samples, restored: true })
      console.info(JSON.stringify({ reviewed: behavior.id, samples: samples.length, restored: true }))
      await writeFile(join(output, 'review.json'), `${JSON.stringify({ chromium: browser.version(), rows, errors }, null, 2)}\n`)
    }
    assert.deepEqual(errors, [])
    const cards = rows.map(row => `<article><h2>${row.id}</h2><div>${row.samples.map(sample => `<figure><img src="${sample.screenshot}"><figcaption>${sample.fraction * 100}%</figcaption></figure>`).join('')}</div></article>`).join('')
    await writeFile(join(output, 'review.html'), `<!doctype html><html><meta charset="utf-8"><title>Vivid behavior review</title><style>body{font:16px sans-serif;background:#eee}article{background:white;padding:12px;margin:12px}article>div{display:flex}figure{margin:6px;flex:1}img{width:100%}</style><h1>All 30 behaviors · three stages each</h1>${cards}</html>`)
    console.info(JSON.stringify({ completed: rows.length, chromium: browser.version(), pageErrors: errors.length }))
  }
  finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
