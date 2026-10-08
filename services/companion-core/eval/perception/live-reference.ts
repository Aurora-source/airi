import type { ScreenFrame } from '../../src/perception/ports/contracts'

import process from 'node:process'

import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { DpapiSecretStore } from '../../src/auth/secret-store'
import { loadConfig, resolveHome } from '../../src/config/config'
import { OwnedScreenCapture } from '../../src/perception/capture/owner'
import { PrivacyGate } from '../../src/perception/privacy/gate'
import { PerceptionService } from '../../src/perception/service'
import { VisionChain } from '../../src/perception/vision/chain'
import { OpenAiVisionAdapter } from '../../src/perception/vision/openai-adapter'

/**
 * Calls an existing configured cloud model with generated reference images only.
 * Images remain in memory. Output contains scores and timings, never image bytes, keys, or model prose.
 *
 * Call stack:
 * validateReferences
 *   -> DPAPI key -> configured OpenAiVisionAdapter
 *   -> reference renderer -> OwnedScreenCapture -> look_now -> numeric evidence
 */
async function validateReferences(): Promise<void> {
  if (!process.argv.includes('--authorize-upload'))
    throw new Error('Reference validation requires --authorize-upload')
  const modelIndex = process.argv.indexOf('--model')
  const modelId = modelIndex >= 0 ? process.argv[modelIndex + 1] : undefined
  const config = await loadConfig()
  const model = modelId ? config.models[modelId] : undefined
  const provider = model ? config.providers[model.provider] : undefined
  if (!model || !provider || provider.locality !== 'cloud' || !model.capabilities.images || !provider.keyRef)
    throw new Error('Select an existing cloud vision model with --model')
  const key = await new DpapiSecretStore(join(resolveHome(), 'secrets')).read(provider.keyRef)
  if (!key)
    throw new Error('Configured vision key is unavailable')
  const adapter = new OpenAiVisionAdapter({ id: modelId!, locality: 'cloud', base_url: provider.baseURL, model: model.model, api_key: key, structured_output: model.capabilities.structuredOutput === true })
  const renderer = fileURLToPath(new URL('./render-reference.ps1', import.meta.url))
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const run = promisify(execFile)
  const scenes = [
    { id: 'code', scene: 'code', text: /greet|function|hello|error/i },
    { id: 'browser', scene: 'browser', text: /tomato|soup|recipe|ingredients/i },
    { id: 'terminal', scene: 'terminal', text: /server|3000|tests|passed/i },
    { id: 'media', scene: 'media', text: /moon|paused|night|00:42/i },
    { id: 'desktop', scene: 'desktop', text: /documents|browser|recycle|start/i },
    { id: 'changed-window', scene: 'other', text: /network|wi-fi|connected|online/i },
  ]
  let current = scenes[0]
  let captureMs = 0
  const capture = new OwnedScreenCapture({
    capture: async (signal): Promise<ScreenFrame> => {
      const start = performance.now()
      const result = await run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', renderer, '-Scene', current.id], { signal, maxBuffer: 1024 * 1024, windowsHide: true })
      const payload = JSON.parse(result.stdout) as { image: string, samples: string }
      captureMs = performance.now() - start
      return { capture_id: current.id, captured_at: Date.now(), source: { kind: 'reference', id: current.id, generation: 1 }, width: 960, height: 540, image: { mime_type: 'image/png', bytes: Buffer.from(payload.image, 'base64') }, samples: Buffer.from(payload.samples, 'base64'), safety: { private_context: false, locked: false, sensitive: false } }
    },
    shutdown: async () => {},
  })
  const service = new PerceptionService({ capture, privacy: new PrivacyGate(), vision: new VisionChain({ profile: 'cloud', adapters: [adapter], attempt_timeout_ms: 11000 }) }, { capture_timeout_ms: 10000, vision_timeout_ms: 12000, ttl_ms: 15000 })
  const evidence: object[] = []
  try {
    for (const scene of scenes) {
      current = scene
      const start = performance.now()
      const result = await service.look_now()
      const row = { scene: scene.id, status: result.status, reference_render_ms: captureMs, pipeline_ms: performance.now() - start }
      if (result.status === 'fresh') {
        const observation = result.observation
        const text = `${observation.visible_text_summary} ${observation.concise_summary} ${observation.media.title_like_text} ${observation.media.subtitle_like_text}`
        const inventedBrand = /visual studio code|vs code|google chrome|mozilla firefox|youtube|netflix/i.test(text)
        const inventedPeople = (observation.people_count ?? 0) > 0
        const playbackContradiction = scene.id === 'media' && observation.media.playback === 'playing'
        evidence.push({ ...row, scene_correct: observation.scene_type === scene.scene, visible_text_useful: scene.text.test(text), confidence: observation.confidence, media_detected: observation.media.detected, playback_correct: scene.id !== 'media' || observation.media.playback === 'paused', checked_hallucinations: Number(inventedBrand) + Number(inventedPeople) + Number(playbackContradiction) })
      }
      else {
        evidence.push(row)
      }
    }
    const callsBeforeStatic = service.metrics().vision_requests
    for (let i = 0; i < 3; i++) await service.tick()
    console.info(JSON.stringify({ kind: 'live-cloud-generated-reference-scenes', model: model.model, sample_count: scenes.length, real_desktop_uploaded: false, raw_images_persisted: false, broad_accuracy_claim: false, hallucination_checks: ['invented brand', 'invented people', 'contradicted paused playback'], static_additional_calls: service.metrics().vision_requests - callsBeforeStatic, evidence, metrics: service.metrics() }))
    if (service.metrics().observations === 0)
      process.exitCode = 1
  }
  finally { await service.shutdown() }
}

void validateReferences().catch(() => {
  console.error('Reference vision validation failed. No provider content or credential is logged.')
  process.exitCode = 1
})
