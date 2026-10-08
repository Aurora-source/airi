// Plays the Windows capture helper over stdin and stdout, without touching the screen.
// argv[2] is a JSON script: { readyDelayMs?, exitBeforeReady?, replies: Step[] }.
// Step: { kind: 'frame', display?, app?, title?, delayMs? } | { kind: 'locked' } | { kind: 'fail' } | { kind: 'exit' } | { kind: 'silent' }
// A frame's JPEG bytes are [id, id, id], so a test can tell which request a frame answers.
import process from 'node:process'

import { Buffer } from 'node:buffer'
import { createInterface } from 'node:readline'

const script = JSON.parse(process.argv[2] ?? '{}')
const replies = script.replies ?? []
let step = 0

if (script.exitBeforeReady)
  process.exit(3)

setTimeout(() => {
  process.stdout.write('{"ready":true}\n')
  createInterface({ input: process.stdin }).on('line', (line) => {
    const [command, rawId] = line.split(' ')
    if (command !== 'capture')
      return
    const id = Number(rawId)
    const next = replies[Math.min(step, replies.length - 1)] ?? { kind: 'frame' }
    step++
    if (next.kind === 'exit')
      process.exit(4)
    if (next.kind === 'silent')
      return
    if (next.kind === 'locked') {
      process.stdout.write(`${JSON.stringify({ id, ok: false, error: 'locked' })}\n`)
      return
    }
    if (next.kind === 'fail') {
      process.stdout.write(`${JSON.stringify({ id, ok: false, error: 'capture-failed' })}\n`)
      return
    }
    const reply = {
      id,
      ok: true,
      capturedAt: Date.now(),
      display: next.display ?? 'DISPLAY1|1920x1080@0,0',
      width: 1280,
      height: 720,
      locked: false,
      app: next.app,
      title: next.title,
      windowId: '1a2b',
      samples: Buffer.alloc(2304, 90).toString('base64'),
      jpeg: Buffer.from([id, id, id]).toString('base64'),
    }
    setTimeout(() => process.stdout.write(`${JSON.stringify(reply)}\n`), next.delayMs ?? 0)
  })
}, script.readyDelayMs ?? 0)
