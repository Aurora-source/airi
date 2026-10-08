import assert from 'node:assert/strict'
import process from 'node:process'

import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { chromium } from 'playwright'

async function main() {
  const [directory, evidenceDirectory, url = 'http://127.0.0.1:5199/'] = process.argv.slice(2)
  if (!directory || !evidenceDirectory)
    throw new Error('Supply the local corpus and evidence directories.')
  const files = (await readdir(directory)).filter(name => name.toLowerCase().endsWith('.vrm')).sort().map(name => join(directory, name))
  assert.equal(files.length, 6, 'The local acceptance corpus must contain all six VRMs.')
  await mkdir(evidenceDirectory, { recursive: true })
  const browser = await chromium.launch({ headless: true, args: ['--enable-precise-memory-info'] })
  let progressTimer
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
    progressTimer = setInterval(async () => {
      try {
        const progress = await page.evaluate(() => ({ snapshot: window.__airiVisualDemo?.snapshot(), status: document.querySelector('[data-testid="status"]')?.textContent }))
        console.info(JSON.stringify({ progress }))
      }
      catch {
        // The final cleanup can close the page while a diagnostic read is pending.
      }
    }, 30000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(url)
    await page.getByTestId('corpus-files').setInputFiles(files)
    await page.waitForFunction(() => !!window.__airiVisualDemo?.snapshot().loaded, undefined, { timeout: 60000 })
    assert.equal(await page.evaluate(() => window.__airiVisualDemo.snapshot().models), 6)
    await page.locator('[data-behavior="amused"]').click()
    await page.waitForFunction(() => window.__airiVisualDemo.snapshot().behavior === 'amused')
    await page.getByRole('button', { name: 'Native ACT interruption' }).click()
    await page.waitForFunction(() => window.__airiVisualDemo.snapshot().blocked)
    assert.equal(await page.evaluate(() => window.__airiVisualDemo.play('concerned')), 'blocked')
    await page.waitForFunction(() => !window.__airiVisualDemo.snapshot().blocked, undefined, { timeout: 15000 })
    await page.getByRole('checkbox', { name: 'Speaking owner' }).check()
    await page.waitForFunction(() => window.__airiVisualDemo.snapshot().blocked)
    assert.equal(await page.evaluate(() => window.__airiVisualDemo.play('happy')), 'blocked')
    await page.getByRole('checkbox', { name: 'Speaking owner' }).uncheck()
    await page.waitForFunction(() => !window.__airiVisualDemo.snapshot().blocked)
    await page.locator('[data-behavior="happy"]').click()
    await page.waitForFunction(() => window.__airiVisualDemo.expressionValue('happy') > 0.05)
    await page.locator('[data-native-expression="happy"]').click()
    await page.waitForTimeout(2600)
    assert.equal(await page.evaluate(() => window.__airiVisualDemo.expressionValue('happy')), 0, 'Native preview must restore neutral after releasing the visual owner.')
    await page.getByRole('button', { name: 'Run idle for 3 minutes' }).click()
    await page.screenshot({ path: join(evidenceDirectory, 'gallery.png') })
    const visualSamples = []
    for (let index = 0; !process.argv.includes('--runtime-only') && index < files.length; index++) {
      await page.getByRole('combobox', { name: 'Avatar', exact: true }).selectOption(String(index))
      await page.waitForFunction(name => window.__airiVisualDemo.snapshot().loaded === name, basename(files[index]), { timeout: 60000 })
      for (const behavior of ['happy', 'thinking', 'surprised', 'stretch']) {
        await page.evaluate(() => window.__airiVisualDemo.stop())
        assert.equal(await page.evaluate(({ behavior, progress }) => window.__airiVisualDemo.review(behavior, progress), { behavior, progress: behavior === 'surprised' ? 0.14 : 0.42 }), 'started')
        await page.getByTestId('avatar-viewport').scrollIntoViewIfNeeded()
        const before = await page.evaluate(() => window.__airiVisualDemo.snapshot().frameCount)
        await page.waitForFunction(previous => window.__airiVisualDemo.snapshot().frameCount > previous + 2, before)
        const screenshot = `model-${index + 1}-${behavior}.png`
        await page.getByTestId('avatar-viewport').screenshot({ path: join(evidenceDirectory, screenshot) })
        visualSamples.push({ model: index + 1, behavior, screenshot, snapshot: await page.evaluate(() => window.__airiVisualDemo.snapshot()) })
      }
    }
    if (visualSamples.length)
      await writeFile(join(evidenceDirectory, 'visual-samples.json'), `${JSON.stringify(visualSamples, null, 2)}\n`)
    await page.evaluate(() => window.__airiVisualDemo.stop())
    // Keep real WebGL rendering while reducing software rasterization cost for the switching stress test.
    await page.getByTestId('avatar-viewport').evaluate((element) => {
      element.style.height = '128px'
    })
    await page.getByRole('button', { name: 'Run corpus twice' }).click()
    await page.waitForFunction(() => !!window.__airiVisualDemo.snapshot().loaded)
    await page.getByRole('checkbox', { name: 'Manual owner' }).check()
    await page.waitForFunction(() => document.querySelector('[data-testid="status"]')?.textContent === 'Demonstration cancelled.')
    assert.equal(await page.evaluate(() => window.__airiVisualDemo.snapshot().enabled), false, 'Cancelled corpus must not restart idle from a stale finally block.')
    await page.getByRole('checkbox', { name: 'Manual owner' }).uncheck()
    await page.waitForFunction(() => !window.__airiVisualDemo.snapshot().blocked)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Performance.enable')
    await cdp.send('HeapProfiler.collectGarbage')
    await page.getByRole('button', { name: 'Run corpus twice' }).click()
    await page.getByTestId('corpus-result').waitFor({ timeout: 600000 })
    const result = JSON.parse(await page.getByTestId('corpus-result').textContent())
    await writeFile(join(evidenceDirectory, 'corpus-exercise.json'), `${JSON.stringify(result, null, 2)}\n`)
    assert.equal(result.failed, undefined)
    assert.equal(result.rows.length, 12)
    for (const row of result.rows) {
      assert.equal(row.neutralWeights, true, 'Expressions must be released after exercise.')
      assert.equal(row.disposedSafe, true, 'Disposed controllers must leave the skeleton untouched.')
      assert.equal(row.compatible.length, 30)
      assert.equal(row.renderedBehaviorFrames, 360)
      assert.equal(row.neutralPoses, true, 'Every affected bone must restore its sampled base.')
      assert.equal(row.finiteTransforms, true, 'Body motion and springs must remain finite.')
      assert.ok(row.maxBoneOffset < 0.85)
      assert.ok(row.extentRatio < 1.5, 'Motion must not create runaway model bounds.')
    }
    for (let i = 0; i < 6; i++)
      assert.deepEqual(result.rows[i].memory, result.rows[i + 6].memory, 'Resources for the same model must stay bounded across passes.')
    await cdp.send('HeapProfiler.collectGarbage')
    const before = await cdp.send('Performance.getMetrics')
    await page.getByRole('button', { name: 'Run corpus twice' }).click()
    await page.waitForFunction(last => window.__airiVisualDemo.snapshot().loaded === last && !!document.querySelector('[data-testid="corpus-result"]') && document.querySelector('[data-testid="status"]')?.textContent === 'Corpus run completed.', basename(files.at(-1)), { timeout: 600000 })
    const repeated = JSON.parse(await page.getByTestId('corpus-result').textContent())
    assert.equal(repeated.failed, undefined)
    assert.equal(repeated.rows.length, 12)
    for (const row of repeated.rows) {
      assert.equal(row.neutralWeights, true)
      assert.equal(row.disposedSafe, true)
      assert.equal(row.compatible.length, 30)
      assert.equal(row.neutralPoses, true)
      assert.equal(row.finiteTransforms, true)
      const first = result.rows.find(original => original.file === row.file)
      assert.deepEqual(first.memory, row.memory)
    }
    await cdp.send('HeapProfiler.collectGarbage')
    const after = await cdp.send('Performance.getMetrics')
    const snapshot = await page.evaluate(() => window.__airiVisualDemo.snapshot())
    await page.evaluate(() => window.__airiVisualDemo.detach())
    await page.waitForFunction(() => !window.__airiVisualDemo.snapshot().loaded)
    const stopped = await page.evaluate(() => window.__airiVisualDemo.snapshot().frameCount)
    await page.waitForTimeout(1000)
    assert.equal(await page.evaluate(() => window.__airiVisualDemo.snapshot().frameCount), stopped)
    assert.deepEqual(errors, [])
    const metrics = values => Object.fromEntries(values.metrics.filter(m => ['JSHeapUsedSize', 'Nodes', 'JSEventListeners'].includes(m.name)).map(m => [m.name, m.value]))
    const evidence = { chromium: browser.version(), actorPriority: true, speakingPriority: true, unmountStopsFrames: true, snapshot, result, repeated, metricsBefore: metrics(before), metricsAfter: metrics(after), pageErrors: errors.length }
    await writeFile(join(evidenceDirectory, 'corpus-runtime.json'), `${JSON.stringify(evidence, null, 2)}\n`)
    assert.ok(evidence.metricsAfter.JSEventListeners <= evidence.metricsBefore.JSEventListeners, 'Repeated switching must not retain extra listeners.')
    assert.ok(evidence.metricsAfter.Nodes <= evidence.metricsBefore.Nodes, 'Repeated switching must not retain extra DOM nodes.')
    assert.ok(evidence.metricsAfter.JSHeapUsedSize <= evidence.metricsBefore.JSHeapUsedSize * 1.1 + 1000000, 'Post-GC heap must remain bounded after warmup.')
    console.info(JSON.stringify({ chromium: evidence.chromium, models: 6, passes: 4, behaviors: 30, actorPriority: true, speakingPriority: true, unmountStopsFrames: true, cpuMs: snapshot.cpuMs, metricsBefore: evidence.metricsBefore, metricsAfter: evidence.metricsAfter }))
  }
  finally {
    clearInterval(progressTimer)
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
