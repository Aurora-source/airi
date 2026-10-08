import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import type { CaptureBackend } from '../perception/capture/owner'
import type { ScreenFrame } from '../perception/ports/contracts'
import type { SafetyLists } from './screen-safety'

import process from 'node:process'

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as v from 'valibot'

import { abortable, PerceptionFailure } from '../perception/ports/failure'
import { classifyWindow } from './screen-safety'

/** A reply line above this size is not a frame. The helper gets killed instead of filling memory. */
const MAX_LINE_CHARS = 8 * 1024 * 1024

/** Labels of the capture contract are at most 256 characters. Longer titles are cut, not rejected. */
const MAX_LABEL = 256

const replySchema = v.variant('ok', [
  v.object({
    id: v.number(),
    ok: v.literal(true),
    capturedAt: v.number(),
    display: v.string(),
    width: v.number(),
    height: v.number(),
    app: v.optional(v.string()),
    title: v.optional(v.string()),
    windowId: v.optional(v.string()),
    samples: v.string(),
    jpeg: v.string(),
  }),
  v.object({ id: v.number(), ok: v.literal(false), error: v.picklist(['locked', 'capture-failed']) }),
])

type Reply = v.InferOutput<typeof replySchema>

/**
 * The host loop of the helper. It compiles `windows-capture.cs` once, prints `{"ready":true}`,
 * then answers each `capture <id> <maxWidth> <quality>` line with one JSON line that starts with `{"id":<id>,`.
 * It runs below normal priority, so capture never competes with a game or the voice pipeline.
 */
const HOST_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '[System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = "BelowNormal"',
  'Add-Type -AssemblyName System.Drawing, System.Windows.Forms',
  'Add-Type -Path $env:COMPANION_CAPTURE_SOURCE -ReferencedAssemblies System.Drawing, System.Windows.Forms',
  '[CompanionScreenCapture]::Initialize()',
  '[Console]::Out.WriteLine(\'{"ready":true}\')',
  'while ($null -ne ($line = [Console]::In.ReadLine())) {',
  '  $parts = $line.Split(" ")',
  '  if ($parts.Length -ne 4 -or $parts[0] -ne "capture") { continue }',
  '  $id = [int]$parts[1]',
  '  try { $json = [CompanionScreenCapture]::Capture([int]$parts[2], [int]$parts[3]); [Console]::Out.WriteLine(\'{"id":\' + $id + \',\' + $json.Substring(1)) }',
  '  catch { [Console]::Out.WriteLine(\'{"id":\' + $id + \',"ok":false,"error":"capture-failed"}\') }',
  '}',
].join('\n')

export interface WindowsCaptureOptions {
  /** Width of the encoded frame. The helper downscales before encoding. */
  maxWidth: number
  /** JPEG quality, 30 to 95. */
  quality: number
  /** Extra classified and sensitive apps for {@link classifyWindow}. */
  lists?: SafetyLists
  /** @default 20000 */
  readyTimeoutMs?: number
  /** Time to wait after a failed helper start before the next try. @default 30000 */
  restartDelayMs?: number
  now?: () => number
  /** Starts the helper process. Tests start a fake helper that speaks the same line protocol. */
  launch?: () => ChildProcessWithoutNullStreams
}

interface Helper {
  child: ChildProcessWithoutNullStreams
  ready: Promise<void>
  /** Correlation key is the request id. A reply without a pending entry belongs to a cancelled capture. */
  pending: Map<number, { resolve: (reply: Reply) => void, reject: (error: unknown) => void }>
}

/**
 * Captures the primary display through one persistent Windows PowerShell 5.1 helper process.
 *
 * State:
 * - helper process: started by {@link WindowsScreenCaptureBackend.start} or the next capture, replaced after it exits.
 * - display key and generation: a new display key bumps the generation and reports a source change.
 *
 * Frames stay in memory. Window titles and image bytes are never logged. A cancelled capture removes its pending
 * entry, so its late reply is dropped without being decoded.
 *
 * Call stack:
 *
 * OwnedScreenCapture.capture (../perception/capture/owner)
 *   -> {@link WindowsScreenCaptureBackend.capture}
 *     -> helper stdin `capture <id> ...` -> stdout reply line -> ScreenFrame
 */
export class WindowsScreenCaptureBackend implements CaptureBackend {
  private helper?: Helper
  private nextId = 0
  private displayKey?: string
  private generation = 0
  private closed = false
  private startBlockedUntil = 0
  private sourceListener?: (available: boolean) => void
  private readonly now: () => number

  constructor(private readonly options: WindowsCaptureOptions) {
    this.now = options.now ?? Date.now
  }

  /** The owner learns about display changes here, so it can reject the frames of the old display. */
  onSourceChange(listener: (available: boolean) => void): void {
    this.sourceListener = listener
  }

  /** Starts the helper ahead of the first capture. Compiling the helper takes about two seconds. */
  start(): void {
    if (!this.closed && !this.helper && this.now() >= this.startBlockedUntil)
      this.helper = this.launch()
  }

  async capture(signal: AbortSignal): Promise<ScreenFrame> {
    if (this.closed)
      throw new PerceptionFailure('source-lost')
    this.start()
    const helper = this.helper
    if (!helper)
      throw new PerceptionFailure('invalid-capture')
    await abortable(helper.ready, signal)
    const id = ++this.nextId
    const sentAt = this.now()
    const reply = await new Promise<Reply>((resolve, reject) => {
      const abort = () => {
        helper.pending.delete(id)
        reject(new PerceptionFailure('cancelled'))
      }
      if (signal.aborted)
        return abort()
      signal.addEventListener('abort', abort, { once: true })
      helper.pending.set(id, {
        resolve: (value) => {
          signal.removeEventListener('abort', abort)
          resolve(value)
        },
        reject: (error) => {
          signal.removeEventListener('abort', abort)
          reject(error)
        },
      })
      helper.child.stdin.write(`capture ${id} ${this.options.maxWidth} ${this.options.quality}\n`)
    })
    return this.frameOf(reply, sentAt, this.now())
  }

  /** Rejects pending captures, closes the helper's stdin so its loop ends, and kills it if it does not exit. */
  async shutdown(): Promise<void> {
    if (this.closed)
      return
    this.closed = true
    const helper = this.helper
    this.helper = undefined
    if (!helper)
      return
    this.fail(helper, new PerceptionFailure('source-lost'))
    const exited = new Promise<void>(resolve => helper.child.once('exit', () => resolve()))
    helper.child.stdin.end()
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(resolve, 2000, 'late')
    })
    if (helper.child.exitCode === null && await Promise.race([exited, late]) === 'late')
      helper.child.kill()
    clearTimeout(timer)
  }

  private frameOf(reply: Reply, sentAt: number, receivedAt: number): ScreenFrame {
    if (!reply.ok) {
      // A locked workstation or a secure desktop (UAC, sign-in) blocks perception like a privacy rule.
      throw new PerceptionFailure(reply.error === 'locked' ? 'privacy' : 'invalid-capture')
    }
    if (this.displayKey !== undefined && this.displayKey !== reply.display) {
      // A new resolution or primary display is a new source. The owner rejects this capture and revokes current facts.
      this.displayKey = reply.display
      this.generation++
      this.sourceListener?.(true)
      throw new PerceptionFailure('source-lost')
    }
    this.displayKey = reply.display
    const samples = new Uint8Array(2304)
    const decoded = Buffer.from(reply.samples, 'base64')
    if (decoded.byteLength !== samples.byteLength)
      throw new PerceptionFailure('invalid-capture')
    samples.set(decoded)
    decoded.fill(0)
    const app = reply.app?.slice(0, MAX_LABEL)
    const title = reply.title?.slice(0, MAX_LABEL)
    return {
      capture_id: randomUUID(),
      // The helper clock can be coarser than Node's. The capture happened between the request and the reply.
      captured_at: Math.min(Math.max(reply.capturedAt, sentAt), receivedAt),
      source: {
        kind: 'display',
        id: 'primary',
        generation: this.generation,
        display_id: reply.display.slice(0, MAX_LABEL),
        window_id: reply.windowId?.slice(0, MAX_LABEL),
        foreground_app: app,
        window_title: title,
      },
      width: reply.width,
      height: reply.height,
      samples,
      image: { mime_type: 'image/jpeg', bytes: Buffer.from(reply.jpeg, 'base64') },
      safety: classifyWindow({ app, title, locked: false }, this.options.lists),
    }
  }

  private launch(): Helper {
    const child = this.options.launch?.() ?? spawnPowerShellHelper()
    const pending: Helper['pending'] = new Map()
    let markReady!: () => void
    let failReady!: (error: unknown) => void
    const ready = new Promise<void>((resolve, reject) => {
      markReady = resolve
      failReady = reject
    })
    // A capture that is waiting for readiness gets the rejection. Without a waiter it must not become unhandled.
    ready.catch(() => {})
    const helper: Helper = { child, ready, pending }
    let isReady = false
    const readyTimer = setTimeout(() => {
      if (!isReady)
        child.kill()
    }, this.options.readyTimeoutMs ?? 20_000)

    const onLine = (line: string) => {
      let value: unknown
      try {
        value = JSON.parse(line)
      }
      catch {
        return
      }
      if (!isReady) {
        if ((value as { ready?: unknown }).ready === true) {
          isReady = true
          clearTimeout(readyTimer)
          markReady()
        }
        return
      }
      const parsed = v.safeParse(replySchema, value)
      if (!parsed.success)
        return
      const entry = pending.get(parsed.output.id)
      // No entry: the capture was cancelled or timed out. Its frame is dropped here, undecoded.
      if (!entry)
        return
      pending.delete(parsed.output.id)
      entry.resolve(parsed.output)
    }

    // Lines arrive in chunks. Only the unfinished tail is kept between chunks.
    let partial: string[] = []
    let partialChars = 0
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      let start = 0
      let index = chunk.indexOf('\n', start)
      while (index >= 0) {
        const line = partial.join('') + chunk.slice(start, index)
        partial = []
        partialChars = 0
        onLine(line.trim())
        start = index + 1
        index = chunk.indexOf('\n', start)
      }
      if (start < chunk.length) {
        partial.push(chunk.slice(start))
        partialChars += chunk.length - start
        if (partialChars > MAX_LINE_CHARS) {
          partial = []
          partialChars = 0
          child.kill()
        }
      }
    })
    // stderr carries PowerShell diagnostics, which can quote a window title. It is drained and never logged.
    child.stderr.resume()
    child.stdin.on('error', () => {})

    const onEnd = () => {
      clearTimeout(readyTimer)
      if (!isReady) {
        this.startBlockedUntil = this.now() + (this.options.restartDelayMs ?? 30_000)
        failReady(new PerceptionFailure('invalid-capture'))
      }
      this.fail(helper, new PerceptionFailure('invalid-capture'))
      if (this.helper === helper)
        this.helper = undefined
    }
    child.once('exit', onEnd)
    child.once('error', onEnd)
    return helper
  }

  private fail(helper: Helper, error: PerceptionFailure): void {
    for (const entry of helper.pending.values())
      entry.reject(error)
    helper.pending.clear()
  }
}

/**
 * Starts the capture helper in Windows PowerShell 5.1.
 *
 * NOTICE:
 * Node has no screen capture API outside Electron, and the Core runs as a plain Node process.
 * Windows PowerShell 5.1 ships with Windows and can compile the helper with System.Drawing.
 * The absolute System32 path stops a planted powershell.exe on PATH from running.
 * Removal condition: the workspace adds a maintained native capture binding, or AIRI hands frames to the Core.
 */
function spawnPowerShellHelper(): ChildProcessWithoutNullStreams {
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const encoded = Buffer.from(HOST_SCRIPT, 'utf16le').toString('base64')
  return spawn(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    windowsHide: true,
    env: { ...process.env, COMPANION_CAPTURE_SOURCE: fileURLToPath(new URL('./windows-capture.cs', import.meta.url)) },
  })
}
