#!/usr/bin/env tsx
import type { Socket } from 'node:net'

import type { BrowserContext, Page } from 'playwright'

import process from 'node:process'

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'

import { errorMessageFrom } from '@moeru/std'
import { Client } from '@proj-airi/server-sdk'
import { chromium } from 'playwright'

const STAGE = 'http://127.0.0.1:5183'
const STAGE_MODULE = 'proj-airi:stage-web'
/** Windows named pipe prefix, for example \\.\pipe\airi-mpv. */
const PIPE_PREFIX = '\\\\.\\pipe\\'

interface StackState { gateway: string, ops: string, inference: string, channel: string, provider: string, pipe: string }

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms))

async function waitFor<T>(read: () => Promise<T> | T, check: (value: T) => boolean, timeoutMs = 30_000, stepMs = 200): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let value = await read()
  while (!check(value)) {
    if (Date.now() > deadline)
      throw new Error(`timed out: ${JSON.stringify(value).slice(0, 400)}`)
    await sleep(stepMs)
    value = await read()
  }
  return value
}

/**
 * Real Stage validation for the combined R6 + R7 runtime. It drives stage-web in Chromium against the live stack from
 * live-stack.mts: the real server channel, the Core gateway on port 11980, and a deterministic fake provider.
 *
 * - Setup: configures chat and speech through the app's own stores and imports VRM files through the model settings UI.
 *   VRM bytes stay in the dedicated browser profile, never in Git.
 * - Checks: VRM binding, idle, every Director affect behavior, local and remote activities, speech with ACT, a real mpv
 *   pause through R6 admission to a Director reaction, user interruption, model switch and return, and cancel.
 *
 * Usage: tsx eval/director/live-stage.mts --state <stack-state.json> --out <dir> --profile <dir> --vrm <a.vrm>
 *        --vrm2 <b.vrm> --mpv <mpv.exe> --video <file.mkv> [--setup | --configure]
 *
 * Call stack:
 *
 * main
 *   -> setupStage (pinia stores, model import) -> scenario steps
 *     -> probe channel client (output:visual:request) -> stage VisualPresenceHost
 *     -> mpv IPC pause -> Core MediaSourceManager -> CompanionWatch -> CompanionDirector -> stage
 */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { state: { type: 'string' }, out: { type: 'string' }, profile: { type: 'string' }, vrm: { type: 'string' }, vrm2: { type: 'string' }, mpv: { type: 'string' }, video: { type: 'string' }, setup: { type: 'boolean' }, configure: { type: 'boolean' }, only: { type: 'string' } } })
  if (!values.state || !values.out || !values.profile || !values.vrm || !values.vrm2 || !values.mpv || !values.video)
    throw new Error('Usage: live-stage.mts --state <file> --out <dir> --profile <dir> --vrm <file> --vrm2 <file> --mpv <exe> --video <file> [--setup]')
  const out = values.out
  mkdirSync(out, { recursive: true })
  const state = JSON.parse(readFileSync(values.state, 'utf8')) as StackState
  const results: Record<string, unknown> = {}
  const only = values.only?.split(',')
  const check = async (name: string, run: () => Promise<unknown>) => {
    if (only && !only.some(prefix => name.startsWith(prefix)))
      return
    const started = Date.now()
    try {
      const value = await run() as object
      results[name] = { ok: true, ms: Date.now() - started, ...value }
    }
    catch (error) {
      results[name] = { ok: false, ms: Date.now() - started, error: errorMessageFrom(error) ?? 'failed' }
    }
    console.info(name, JSON.stringify(results[name]).slice(0, 300))
  }
  const ops = async (path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:11980/ops/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'authorization': `Bearer ${state.ops}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return await response.json() as Record<string, any>
  }

  const context: BrowserContext = await chromium.launchPersistentContext(values.profile, {
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: ['--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
  })
  const page = context.pages()[0] ?? await context.newPage()
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message.slice(0, 300)))
  page.on('console', (message) => {
    if (message.type() === 'error')
      consoleErrors.push(message.text().slice(0, 300))
  })
  const shot = (name: string) => page.screenshot({ path: join(out, `${name}.png`) })

  const probe = new Client({ url: state.channel, name: 'r7-live-probe', possibleEvents: ['output:visual:result', 'output:visual:state'], autoConnect: true, autoReconnect: true })
  const visualResults = new Map<string, string>()
  probe.onEvent('output:visual:result', event => visualResults.set(String(event.data.requestId), String(event.data.result)))
  let requestNo = 0
  const visual = async (data: { behavior?: string, activity?: 'idle' | 'listening' | 'thinking' | 'waiting' | 'watching', leaseMs: number }) => {
    const requestId = `probe-${++requestNo}`
    probe.send({ type: 'output:visual:request', data: { requestId, ...data }, route: { destinations: [{ type: 'module', modules: [STAGE_MODULE] }] } })
    return await waitFor(() => visualResults.get(requestId), value => value !== undefined, 5000)
  }
  const cancelVisual = (requestId: string) => probe.send({ type: 'output:visual:cancel', data: { requestId }, route: { destinations: [{ type: 'module', modules: [STAGE_MODULE] }] } })

  let mpv: ReturnType<typeof spawn> | undefined
  let control: Socket | undefined
  try {
    await page.goto(STAGE, { waitUntil: 'domcontentloaded' })
    await sleep(15_000)
    if (values.setup)
      await setupStage(page, state, values.vrm, values.vrm2, out)
    else if (values.configure)
      await configureProviders(page, state)

    const modelIds = JSON.parse(readFileSync(join(out, 'model-ids.json'), 'utf8')) as Record<string, string>
    await page.goto(STAGE, { waitUntil: 'domcontentloaded' })

    await check('a_vrm_bound_visual_available', async () => {
      const started = Date.now()
      const status = await waitFor(() => ops('director/status'), body => body.visual?.available === true, 90_000, 500)
      await sleep(3000)
      await shot('a-bound')
      return { bindMs: Date.now() - started, visual: status.visual, model: await page.evaluate(() => localStorage.getItem('settings/stage/model')) }
    })

    await check('b_idle', async () => {
      for (let i = 0; i < 4; i++) {
        await shot(`b-idle-${i}`)
        await sleep(8000)
      }
      return {}
    })

    await check('c_behaviors', async () => {
      const outcomes: Record<string, string> = {}
      // Held stages show the body language. Durations come from the accepted catalog.
      for (const [behavior, holdMs, totalMs] of [['curious', 1600, 4500], ['amused', 1300, 4000], ['surprised', 500, 2500], ['concerned', 1700, 4700], ['focused', 2000, 5500], ['happy', 1400, 4200]] as const) {
        outcomes[behavior] = await visual({ behavior, leaseMs: 6000 })
        await sleep(holdMs)
        await shot(`c-${behavior}`)
        await sleep(totalMs - holdMs)
      }
      await sleep(2000)
      await shot('c-neutral-after')
      return { outcomes }
    })

    await check('d_activities', async () => {
      const outcomes: Record<string, string> = {}
      for (const activity of ['listening', 'thinking', 'waiting', 'watching'] as const) {
        outcomes[activity] = await visual({ activity, leaseMs: 5000 })
        await sleep(2200)
        await shot(`d-${activity}`)
        cancelVisual(`probe-${requestNo}`)
        await sleep(1500)
      }
      // Listening keeps priority: a reaction during listening is refused.
      await visual({ activity: 'listening', leaseMs: 4000 })
      outcomes['curious-during-listening'] = await visual({ behavior: 'curious', leaseMs: 4000 })
      await sleep(4500)
      return { outcomes }
    })

    await check('e_speech_act_ownership', async () => {
      const before = await ops('director/status')
      const blocked: boolean[] = []
      const poll = setInterval(() => {
        void ops('director/status').then(body => blocked.push(body.visual?.blocked === true))
      }, 250)
      await page.fill('textarea', 'I have great news today!')
      await page.click('button[aria-label="Send message"]')
      await sleep(1000)
      await shot('e-thinking')
      await sleep(2800)
      await shot('e-speaking')
      for (const frame of ['a', 'b', 'c']) {
        await sleep(150)
        await page.locator('canvas').first().screenshot({ path: join(out, `e-mouth-${frame}.png`) })
      }
      await sleep(2500)
      await shot('e-speaking-2')
      await sleep(9000)
      clearInterval(poll)
      await shot('e-after')
      const after = await ops('director/status')
      return {
        speechAttempts: after.director.metrics.speechAttempts - (before.director?.metrics.speechAttempts ?? 0),
        ownedSpeech: after.counters.ownedSpeech - (before.counters?.ownedSpeech ?? 0),
        companionSpeech: after.counters.companionSpeech - (before.counters?.companionSpeech ?? 0),
        visualBlockedDuringSpeech: blocked.includes(true),
        visualReleasedAfter: after.visual.blocked === false,
        ownersAfter: after.visual.owners,
        conversation: after.conversation,
      }
    })

    await check('f_mpv_pause_reaction_through_r6', async () => {
      const before = await ops('director/status')
      mpv = spawn(values.mpv!, ['--no-config', `--input-ipc-server=${PIPE_PREFIX}${state.pipe}`, '--sid=1', '--vo=null', '--ao=null', '--really-quiet', values.video!], { stdio: 'ignore', windowsHide: true })
      control = await openPipe(state.pipe)
      const watching = await waitFor(() => ops('watch/status'), body => body.session?.status === 'watching' && body.session?.playback === 'playing', 30_000, 300)
      await waitFor(() => ops('director/status'), body => body.director?.attention?.watchEvidence === 'fresh', 15_000, 300)
      await sleep(2000)
      await shot('f-watching')
      // Availability and ownership as the Core sees them, so a declined reaction shows its cause.
      const timeline: Array<{ at: number, blocked: boolean, available: boolean, owners: string }> = []
      const poll = setInterval(() => {
        void ops('director/status').then(body => timeline.push({ at: Date.now(), blocked: body.visual?.blocked === true, available: body.visual?.available === true, owners: (body.visual?.owners ?? []).join('+') }))
      }, 100)
      control.write(`${JSON.stringify({ command: ['set_property', 'pause', true] })}\n`)
      const pausedAt = Date.now()
      const after = await waitFor(() => ops('director/status'), body => body.visual?.started > before.visual.started, 15_000, 100).finally(() => {
        clearInterval(poll)
        results.f_timeline = timeline.filter((entry, index) => index === 0 || entry.owners !== timeline[index - 1].owners || entry.available !== timeline[index - 1].available).map(entry => ({ ...entry, at: entry.at - pausedAt }))
      })
      const reactionMs = Date.now() - pausedAt
      await sleep(600)
      await shot('f-reaction')
      await sleep(1000)
      await shot('f-reaction-2')
      const watch = await ops('watch/status')
      control.write(`${JSON.stringify({ command: ['set_property', 'pause', false] })}\n`)
      return { player: watching.session.media.player, reactionMs, visual: after.visual, watchReaction: watch.session?.reaction, lastDecision: after.director.lastDecision }
    })

    await check('g_user_interrupt', async () => {
      const before = await ops('director/status')
      probe.send({ type: 'input:voice:activity', data: { active: true, inputId: 'probe-voice-1' } })
      const during = await waitFor(() => ops('director/status'), body => body.director?.attention?.userSpeaking === true, 5000, 100)
      const watch = await ops('watch/status')
      probe.send({ type: 'input:voice:activity', data: { active: false, inputId: 'probe-voice-1' } })
      await sleep(500)
      const after = await ops('director/status')
      return { userSpeakingSeen: during.director.attention.userSpeaking, watchUserSpeaking: watch.userSpeaking, userSpeechEvents: after.counters.userSpeech - before.counters.userSpeech, activeOutputAfter: after.director.resources.activeOutput }
    })

    await check('h_model_switch_and_return', async () => {
      const secondId = await pickModel(page, basename(values.vrm2!, '.vrm'))
      await page.goto(STAGE, { waitUntil: 'domcontentloaded' })
      await waitFor(() => ops('director/status'), body => body.visual?.available === true, 90_000, 500)
      await sleep(3000)
      await shot('h-second-model')
      const second = await visual({ behavior: 'amused', leaseMs: 5000 })
      await sleep(1200)
      await shot('h-second-amused')
      const primaryId = await pickModel(page, basename(values.vrm!, '.vrm'))
      await page.goto(STAGE, { waitUntil: 'domcontentloaded' })
      await waitFor(() => ops('director/status'), body => body.visual?.available === true, 90_000, 500)
      await sleep(3000)
      await shot('h-primary-again')
      const primary = await visual({ behavior: 'surprised', leaseMs: 5000 })
      await sleep(500)
      await shot('h-primary-surprised')
      return { second, primary, switchedTo: secondId === modelIds.second, returnedTo: primaryId === modelIds.primary, model: await page.evaluate(() => localStorage.getItem('settings/stage/model')) }
    })

    await check('i_cancel', async () => {
      const response = await ops('director/cancel', {})
      const status = await ops('director/status')
      return { response, cancellations: status.director.metrics.cancellations }
    })
  }
  finally {
    control?.write(`${JSON.stringify({ command: ['quit'] })}\n`)
    control?.destroy()
    mpv?.kill()
    results.pageErrors = pageErrors
    results.consoleErrors = consoleErrors.slice(-40)
    results.finalDirector = await ops('director/status').catch(() => undefined)
    results.finalWatch = await ops('watch/status').catch(() => undefined)
    probe.close()
    await context.close()
    await writeFile(join(out, 'live-stage.json'), `${JSON.stringify(results, null, 2)}\n`, 'utf8')
  }
}

/** Configures chat through the Core gateway and speech through the fake provider, then imports both VRM files. */
async function setupStage(page: Page, state: StackState, primary: string, second: string, out: string): Promise<void> {
  await page.evaluate((channel) => {
    localStorage.setItem('onboarding/completed', 'true')
    localStorage.setItem('onboarding/skipped', 'false')
    localStorage.setItem('settings/connection/websocket-url', channel)
  }, state.channel)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await sleep(15_000)
  await configureProviders(page, state)
  const ids: Record<string, string> = {}
  ids.second = await importModel(page, second)
  ids.primary = await importModel(page, primary)
  await writeFile(join(out, 'model-ids.json'), `${JSON.stringify(ids)}\n`, 'utf8')
}

/** Points chat at the Core gateway and speech at the fake provider through the app's own stores. */
async function configureProviders(page: Page, state: StackState): Promise<void> {
  await page.evaluate(async (s) => {
    const root = [...document.querySelectorAll('*')].find(element => (element as unknown as { __vue_app__?: unknown }).__vue_app__) as unknown as { __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, any> } } } } }
    const stores = root.__vue_app__.config.globalProperties.$pinia._s
    const providers = stores.get('provider-config')
    for (const [id, config] of [['openai-compatible', { apiKey: s.inference, baseUrl: s.gateway }], ['openai-compatible-audio-speech', { apiKey: 'fake-key', baseUrl: s.provider }]] as const) {
      providers.ensureProvider(id, id, config)
      await providers.updateProviderConfig(id, config, 'configured')
      providers.markProviderAdded(id)
    }
    const defaults = JSON.parse(localStorage.getItem('airi-card-module-defaults') ?? 'null') ?? {}
    defaults.consciousness = { provider: 'openai-compatible', model: 'companion-chat' }
    defaults.speech = { provider: 'openai-compatible-audio-speech', model: 'tts-1', voice_id: 'alloy' }
    defaults.vision ??= { provider: '', model: '' }
    localStorage.setItem('airi-card-module-defaults', JSON.stringify(defaults))
  }, state)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await sleep(10_000)
}

/** Imports one VRM through the model settings UI and picks it. Returns its display model id. */
async function importModel(page: Page, file: string): Promise<string> {
  await page.goto(`${STAGE}/settings/models`, { waitUntil: 'domcontentloaded' })
  await sleep(10_000)
  await page.getByRole('button', { name: 'Select model' }).click()
  await sleep(1500)
  await page.getByRole('button', { name: /Options for Display Models/i }).first().click()
  await sleep(800)
  const chooser = page.waitForEvent('filechooser', { timeout: 15_000 })
  await page.getByRole('menuitem', { name: /^VRM$/ }).click()
  await (await chooser).setFiles(file)
  await sleep(8000)
  const name = basename(file, '.vrm')
  const card = page.locator('div', { hasText: name }).filter({ has: page.getByRole('button', { name: /Pick/i }) }).last()
  await card.getByRole('button', { name: /Pick/i }).first().click()
  await sleep(5000)
  return await page.evaluate(() => localStorage.getItem('settings/stage/model') ?? '')
}

/** Picks an imported model by its file name with the card's own Pick button, like a user. Returns the selected id. */
async function pickModel(page: Page, name: string): Promise<string> {
  await page.goto(`${STAGE}/settings/models`, { waitUntil: 'domcontentloaded' })
  await sleep(10_000)
  await page.getByRole('button', { name: 'Select model' }).click()
  await sleep(1500)
  const card = page.locator('div', { hasText: name }).filter({ has: page.getByRole('button', { name: /Pick/i }) }).last()
  await card.getByRole('button', { name: /Pick/i }).first().click()
  await sleep(5000)
  return await page.evaluate(() => localStorage.getItem('settings/stage/model') ?? '')
}

async function openPipe(pipe: string): Promise<Socket> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const socket = connect(`${PIPE_PREFIX}${pipe}`)
        socket.once('connect', () => resolve(socket))
        socket.once('error', reject)
      })
    }
    catch {
      await sleep(150)
    }
  }
  throw new Error('mpv pipe did not open')
}

main().then(() => process.exit(0)).catch((error: unknown) => {
  console.error(errorMessageFrom(error) ?? 'live stage failed')
  process.exit(1)
})
