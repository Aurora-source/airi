import process from 'node:process'

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { chromium } from 'playwright'

/** Build review sheets from existing gallery captures. This tool never loads or modifies avatar assets. */
async function main() {
  const [directory, mode] = process.argv.slice(2)
  const corpus = mode === '--corpus'
  const report = JSON.parse(await readFile(join(directory, corpus ? 'visual-samples.json' : 'review.json'), 'utf8'))
  const browser = await chromium.launch({ headless: true })
  try {
    const groups = corpus
      ? [...new Set(report.map(sample => sample.model))].map(model => report.filter(sample => sample.model === model).map(sample => ({ id: `Model ${model}: ${sample.behavior}`, samples: [{ screenshot: sample.screenshot, fraction: sample.behavior === 'surprised' ? 0.14 : 0.42 }] })))
      : Array.from({ length: Math.ceil(report.rows.length / 5) }, (_, index) => report.rows.slice(index * 5, index * 5 + 5))
    const page = await browser.newPage({ viewport: { width: corpus ? 1280 : 1600, height: corpus ? 460 : 1320 } })
    for (let index = 0; index < groups.length; index++) {
      const rows = groups[index]
      const columns = await Promise.all(rows.map(async row => `<article><h2>${row.id}</h2>${(await Promise.all(row.samples.map(async sample => `<figure><img src="data:image/png;base64,${(await readFile(join(directory, sample.screenshot))).toString('base64')}"><figcaption>${Math.round(sample.fraction * 100)}%</figcaption></figure>`))).join('')}</article>`))
      await page.setContent(`<html><style>body{margin:0;font:15px sans-serif;background:#eee;display:flex}article{width:320px}h2{height:30px;margin:6px}figure{margin:0;height:425px}img{width:320px;height:400px;object-fit:cover;object-position:center}figcaption{text-align:center}</style>${columns.join('')}</html>`)
      await page.screenshot({ path: join(directory, `sheet-${index + 1}.png`), fullPage: true })
    }
    console.info(JSON.stringify({ sheets: groups.length, samples: groups.flatMap(rows => rows).length }))
  }
  finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
