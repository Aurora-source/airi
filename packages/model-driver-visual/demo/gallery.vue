<script setup lang="ts">
import type { VRM } from '@pixiv/three-vrm'
import type { VrmFrameRuntimeContext } from '@proj-airi/stage-ui-three/composables/vrm'

import type { ExternalVisualActivity, IdleIntensity, MotionTuning, VisualActivity } from '../src/contracts'
import type { VisualGalleryProbe } from './probe'

import { ThreeScene } from '@proj-airi/stage-ui-three'
import { animations } from '@proj-airi/stage-ui-three/assets/vrm'
import { Box3, Vector3 } from 'three'
import { computed, nextTick, onUnmounted, ref, shallowRef, watch } from 'vue'

import { visualBehaviorCatalog } from '../src/catalog'
import { createVisualBehaviorController } from '../src/controller'
import { poseBones } from '../src/motion'
import { createVrmVisualAdapter } from '../src/vrm'

const scene = shallowRef<InstanceType<typeof ThreeScene>>()
const models = shallowRef<{
  name: string
  url: string
}[]>([])
const selected = ref(-1)
const intensity = ref<IdleIntensity>('normal')
const activity = ref<VisualActivity>('idle')
const status = ref('Choose local VRM files. Files stay in this browser session.')
const loaded = ref('')
const expressions = shallowRef<string[]>([])
const dimensions = ref('')
const result = shallowRef<Record<string, unknown>>()
const manualBlock = ref(false)
const speechBlock = ref(false)
const running = ref(false)
const automaticUntil = ref(0)
const cpu = ref(0)
const bodyAmplitude = ref(1)
const armAmplitude = ref(1)
const handAmplitude = ref(1)
const transitionSpeed = ref(1)
const bodyGestures = ref(true)
const guards: ExternalVisualActivity = { speaking: false, act: false, modelMotion: false, userControl: false }
const corpusGuards: ExternalVisualActivity = { speaking: false, act: false, modelMotion: false, userControl: false }
// Gallery replay ignores catalog cooldowns. Production admission keeps the original cooldown policy.
const controller = createVisualBehaviorController({ catalog: visualBehaviorCatalog.map(behavior => ({ ...behavior, cooldownMs: 0 })) })
let adapter: ReturnType<typeof createVrmVisualAdapter> | undefined
let bound: VRM | undefined
let reviewPose: {
  id: string
  clock: { time: number }
  controller: ReturnType<typeof createVisualBehaviorController>
  adapter: ReturnType<typeof createVrmVisualAdapter>
} | undefined
let preview: {
  name: string
  base: number
  until: number
  owned: boolean
} | undefined
let frameExercise: {
  controller: ReturnType<typeof createVisualBehaviorController>
  adapter: ReturnType<typeof createVrmVisualAdapter>
  advance: () => void
  inspect: () => void
  remaining: number
  resolve: () => void
  reject: () => void
} | undefined
let frameCount = 0
let totalCpu = 0
let loadWait: {
  name: string
  resolve: () => void
  reject: () => void
  timeout: ReturnType<typeof setTimeout>
} | undefined
let alive = true
let runGeneration = 0
const current = computed(() => models.value[selected.value])
const behaviorNames = visualBehaviorCatalog.map(b => b.id)
const levels: IdleIntensity[] = ['still', 'calm', 'normal', 'lively']
const activities: VisualActivity[] = ['idle', 'listening', 'thinking', 'waiting', 'watching']
const embodiedEmotions = [
  { label: 'relaxed', behavior: 'relaxed' },
  { label: 'happy', behavior: 'happy' },
  { label: 'amused', behavior: 'amused' },
  { label: 'sad / concerned', behavior: 'concerned' },
  { label: 'angry', behavior: 'frown' },
  { label: 'surprised', behavior: 'surprised' },
  { label: 'curious', behavior: 'curious' },
  { label: 'focused', behavior: 'focused' },
]
function tuning(): MotionTuning {
  return { bodyAmplitude: bodyAmplitude.value, armAmplitude: armAmplitude.value, handAmplitude: handAmplitude.value, transitionSpeed: transitionSpeed.value, bodyGestures: bodyGestures.value }
}
watch([bodyAmplitude, armAmplitude, handAmplitude, transitionSpeed, bodyGestures], () => controller.setMotionTuning(tuning()))
function playBehavior(id: string) {
  clearReview()
  clearPreview()
  guards.userControl = manualBlock.value || running.value
  controller.setExternalActivity(guards)
  const outcome = controller.playVisualBehavior(id)
  status.value = `${id}: ${outcome}`
  return outcome
}
function clearReview() {
  reviewPose?.controller.dispose()
  reviewPose = undefined
}
function reviewBehavior(id: string, progress: number) {
  const behavior = visualBehaviorCatalog.find(entry => entry.id === id)
  if (!behavior)
    return 'unknown' as const
  if (!bound || running.value || manualBlock.value || guards.act || guards.speaking)
    return 'blocked' as const
  if (reviewPose?.id !== id || progress * behavior.durationMs < reviewPose.clock.time) {
    clearReview()
    clearPreview()
    controller.stop()
    const clock = { time: 0 }
    const reviewAdapter = createVrmVisualAdapter(bound, { modelId: current.value?.name ?? 'local', deferExpressions: true })
    const reviewController = createVisualBehaviorController({ adapter: reviewAdapter, now: () => clock.time, random: () => 0.37, tuning: tuning() })
    reviewController.playVisualBehavior(id)
    reviewPose = { id, clock, controller: reviewController, adapter: reviewAdapter }
  }
  reviewPose.clock.time = Math.max(0, Math.min(1, progress)) * behavior.durationMs
  return 'started' as const
}
function clearPreview() {
  if (preview?.owned && bound?.expressionManager?.getValue(preview.name) === 0.5)
    bound.expressionManager.setValue(preview.name, preview.base)
  preview = undefined
}
function releaseModel() {
  clearReview()
  clearPreview()
  controller.attach()
  adapter = undefined
  bound = undefined
  loaded.value = ''
}
function cancelPending() {
  if (loadWait) {
    clearTimeout(loadWait.timeout)
    loadWait.reject()
    loadWait = undefined
  }
  frameExercise?.reject()
  frameExercise = undefined
}
function selectModel(index: number) {
  releaseModel()
  selected.value = index
}
function chooseFiles(event: Event) {
  const input = event.target as HTMLInputElement
  if (!input.files)
    return
  runGeneration++
  cancelPending()
  running.value = false
  releaseModel()
  for (const model of models.value)
    URL.revokeObjectURL(model.url)
  models.value = Array.from(input.files).filter(file => file.name.toLowerCase().endsWith('.vrm')).map(file => ({ name: file.name, url: URL.createObjectURL(file) }))
  selectModel(models.value.length ? 0 : -1)
}
function synchronizeOwners(context: VrmFrameRuntimeContext) {
  guards.speaking = context.lipSyncActive || speechBlock.value
  guards.act = context.actActive
  guards.userControl = manualBlock.value || !!preview || !!reviewPose || running.value
  controller.setExternalActivity(guards)
}
function synchronizeCorpusOwners(context: VrmFrameRuntimeContext) {
  if (!frameExercise)
    return
  corpusGuards.speaking = context.lipSyncActive || speechBlock.value
  corpusGuards.act = context.actActive
  corpusGuards.userControl = manualBlock.value
  frameExercise.controller.setExternalActivity(corpusGuards)
  if (corpusGuards.speaking || corpusGuards.act || corpusGuards.userControl)
    stopDemo()
}
function poseFrame(vrm: VRM, _delta: number, context: VrmFrameRuntimeContext) {
  if (context.modelSrc !== current.value?.url)
    return
  const started = performance.now()
  if (bound !== vrm) {
    releaseModel()
    bound = vrm
    adapter = createVrmVisualAdapter(vrm, { modelId: current.value?.name ?? 'local', deferExpressions: true })
    controller.attach(adapter)
    controller.setIdleIntensity(intensity.value)
    controller.start()
    expressions.value = Object.keys(vrm.expressionManager?.expressionMap ?? {})
    const size = new Box3().setFromObject(vrm.scene).getSize(new Vector3())
    dimensions.value = size.toArray().map(n => n.toFixed(3)).join(' × ')
    loaded.value = current.value?.name ?? ''
    if (loadWait?.name === loaded.value) {
      clearTimeout(loadWait.timeout)
      loadWait.resolve()
      loadWait = undefined
    }
  }
  if (preview && performance.now() >= preview.until)
    clearPreview()
  if (automaticUntil.value && performance.now() >= automaticUntil.value) {
    automaticUntil.value = 0
    controller.stop()
  }
  synchronizeOwners(context)
  controller.update()
  if (reviewPose) {
    if (context.actActive || context.lipSyncActive || speechBlock.value || manualBlock.value)
      clearReview()
    else
      reviewPose.controller.update()
  }
  synchronizeCorpusOwners(context)
  if (frameExercise) {
    frameExercise.advance()
    frameExercise.controller.update()
  }
  totalCpu += performance.now() - started
  if (++frameCount % 120 === 0) {
    cpu.value = totalCpu / 120
    totalCpu = 0
  }
}
function expressionFrame(_vrm: VRM, _delta: number, context: VrmFrameRuntimeContext) {
  if (context.modelSrc !== current.value?.url)
    return
  synchronizeOwners(context)
  synchronizeCorpusOwners(context)
  if (context.actActive || context.lipSyncActive) {
    clearPreview()
    return
  }
  adapter?.flushExpressions()
  reviewPose?.adapter.flushExpressions()
  if (frameExercise) {
    frameExercise.adapter.flushExpressions()
    frameExercise.inspect()
    if (--frameExercise.remaining === 0) {
      frameExercise.resolve()
      frameExercise = undefined
    }
  }
  if (preview) {
    bound?.expressionManager?.setValue(preview.name, 0.5)
    preview.owned = true
  }
}
watch(scene, (next) => {
  next?.setVrmFrameHook(poseFrame)
  next?.setVrmExpressionFrameHook(expressionFrame)
}, { flush: 'post' })
watch(intensity, value => controller.setIdleIntensity(value))
watch(activity, value => controller.setVisualActivity(value))
function previewExpression(name: string) {
  if (!bound || guards.act || guards.speaking || running.value)
    return
  clearReview()
  clearPreview()
  guards.userControl = true
  controller.setExternalActivity(guards)
  preview = { name, base: bound.expressionManager?.getValue(name) ?? 0, until: performance.now() + 2400, owned: false }
}
function demonstrateIdle() {
  activity.value = 'idle'
  controller.start()
  automaticUntil.value = performance.now() + 180000
  status.value = 'Three-minute idle demonstration running.'
}
function stopDemo() {
  clearReview()
  runGeneration++
  cancelPending()
  running.value = false
  automaticUntil.value = 0
  clearPreview()
  controller.stop()
  status.value = 'Demonstration cancelled.'
}
function waitForModel(name: string) {
  return new Promise<void>((resolve, reject) => {
    if (loaded.value === name) {
      resolve()
      return
    }
    const timeout = setTimeout(() => {
      if (loadWait?.timeout === timeout)
        loadWait = undefined
      reject(new Error('Model load deadline exceeded.'))
    }, 45000)
    loadWait = { name, resolve, reject: () => reject(new Error('Gallery disposed.')), timeout }
  })
}
function exerciseRenderedFrames(testController: ReturnType<typeof createVisualBehaviorController>, testAdapter: ReturnType<typeof createVrmVisualAdapter>, advance: () => void, inspect: () => void) {
  return new Promise<void>((resolve, reject) => {
    frameExercise = { controller: testController, adapter: testAdapter, advance, inspect, remaining: 12, resolve, reject: () => reject(new Error('Corpus exercise cancelled.')) }
  })
}
async function runCorpus() {
  if (!models.value.length || running.value)
    return
  const generation = ++runGeneration
  clearPreview()
  controller.stop()
  running.value = true
  result.value = undefined
  status.value = 'Corpus exercise running.'
  const rows: Record<string, unknown>[] = []
  try {
    for (let pass = 0; pass < 2; pass++) {
      for (let index = 0; index < models.value.length; index++) {
        if (!alive || generation !== runGeneration)
          return
        selectModel(index)
        await nextTick()
        await waitForModel(models.value[index].name)
        if (!bound || generation !== runGeneration)
          return
        controller.stop()
        const vrm = bound
        let clock = 0
        const testAdapter = createVrmVisualAdapter(vrm, { modelId: models.value[index].name, deferExpressions: true })
        const initialExpressions = new Map(Array.from(testAdapter.capabilities.expressions, name => [name, vrm.expressionManager?.getValue(name) ?? 0]))
        const testController = createVisualBehaviorController({ adapter: testAdapter, now: () => clock, random: () => 0.37 })
        const bones = poseBones.flatMap(({ name }) => {
          const node = vrm.humanoid.getNormalizedBoneNode(name)
          return node ? [{ name, node, base: node.quaternion.clone(), written: node.quaternion.clone(), owned: false, measured: node.quaternion.clone(), reference: node.quaternion.clone() }] : []
        })
        let neutralPoses = true
        const neutralFailures: { behavior: string, bone: string, offset: number, base: number[], actual: number[] }[] = []
        let finiteTransforms = true
        let maxBoneOffset = 0
        const extent = new Box3().setFromObject(vrm.scene).getSize(new Vector3()).length()
        let maxExtent = extent
        const compatible: string[] = []
        try {
          for (const behavior of visualBehaviorCatalog) {
            clock += 300001
            if (testController.playVisualBehavior(behavior.id) !== 'started')
              continue
            compatible.push(behavior.id)
            const started = clock
            let sample = 0
            await exerciseRenderedFrames(testController, testAdapter, () => {
              for (const bone of bones) {
                // Keep the expected sampled base when the previous additive write survives the mixer.
                if (!bone.owned || !bone.node.quaternion.equals(bone.written))
                  bone.base.copy(bone.node.quaternion)
              }
              clock = started + behavior.durationMs * ++sample / 12 + (sample === 12 ? 1 : 0)
            }, () => {
              for (const bone of bones) {
                const offset = bone.measured.copy(bone.node.quaternion).normalize().angleTo(bone.reference.copy(bone.base).normalize())
                maxBoneOffset = Math.max(maxBoneOffset, offset)
                if (sample === 12 && !bone.node.quaternion.equals(bone.base)) {
                  neutralPoses = false
                  if (neutralFailures.length < 12)
                    neutralFailures.push({ behavior: behavior.id, bone: bone.name, offset, base: bone.base.toArray(), actual: bone.node.quaternion.toArray() })
                }
                bone.written.copy(bone.node.quaternion)
                bone.owned = sample < 12
              }
              vrm.scene.traverse((node) => {
                if (![...node.position.toArray(), ...node.quaternion.toArray(), ...node.scale.toArray()].every(Number.isFinite))
                  finiteTransforms = false
              })
              if (sample % 3 === 0)
                maxExtent = Math.max(maxExtent, new Box3().setFromObject(vrm.scene).getSize(new Vector3()).length())
            })
          }
          for (const level of levels) {
            testController.setIdleIntensity(level)
            testController.start()
            for (let frame = 0; frame < 600; frame++) {
              clock += 1000
              testController.update()
              testAdapter.flushExpressions()
            }
            testController.stop()
          }
        }
        finally {
          testController.dispose()
        }
        const neutralWeights = Array.from(initialExpressions).every(([name, value]) => (vrm.expressionManager?.getValue(name) ?? 0) === value)
        const before = vrm.humanoid.getNormalizedBoneNode('head')?.quaternion.clone()
        testController.update(clock + 100000)
        const disposedSafe = before?.equals(vrm.humanoid.getNormalizedBoneNode('head')!.quaternion) ?? true
        rows.push({ pass, file: models.value[index].name, compatible, renderedBehaviorFrames: compatible.length * 12, neutralWeights, neutralPoses, neutralFailures, finiteTransforms, maxBoneOffset, extentRatio: maxExtent / extent, disposedSafe, dimensions: dimensions.value, version: vrm.meta.metaVersion, bones: Object.keys(vrm.humanoid.humanBones).length, expressions: Object.keys(vrm.expressionManager?.expressionMap ?? {}), semanticExpressions: Array.from(testAdapter.capabilities.expressions), memory: { ...scene.value?.renderer()?.info.memory } })
      }
    }
    result.value = { passes: 2, models: models.value.length, rows }
    status.value = 'Corpus run completed.'
  }
  catch {
    if (generation !== runGeneration)
      return
    status.value = 'Corpus run failed. Inspect local renderer diagnostics.'
    result.value = { failed: true, rows }
  }
  finally {
    if (alive && generation === runGeneration) {
      running.value = false
      controller.start()
      controller.setIdleIntensity(intensity.value)
    }
  }
}
// Only this isolated development entry exposes diagnostics. The package runtime has no global hooks.
defineExpose({ controller, runCorpus })
const probe: VisualGalleryProbe = {
  snapshot: () => ({ ...(reviewPose?.controller ?? controller).snapshot(), loaded: loaded.value, frameCount, cpuMs: cpu.value, models: models.value.length }),
  play: playBehavior,
  expressionValue: name => bound?.expressionManager?.getValue(name) ?? null,
  stop: () => {
    clearReview()
    controller.stop()
  },
  tune: value => controller.setMotionTuning(value),
  behaviors: visualBehaviorCatalog.map(({ id, durationMs }) => ({ id, durationMs })),
  review: reviewBehavior,
  bones: () => Object.fromEntries(poseBones.flatMap(({ name }) => {
    const node = bound?.humanoid.getRawBoneNode(name)
    return node ? [[name, { quaternion: node.quaternion.toArray(), position: node.getWorldPosition(new Vector3()).toArray() }]] : []
  })),
  detach: () => {
    stopDemo()
    selectModel(-1)
  },
}
if (import.meta.env.DEV || import.meta.env.MODE === 'review')
  window.__airiVisualDemo = probe
onUnmounted(() => {
  alive = false
  runGeneration++
  cancelPending()
  scene.value?.setVrmFrameHook()
  scene.value?.setVrmExpressionFrameHook()
  releaseModel()
  controller.dispose()
  for (const model of models.value)
    URL.revokeObjectURL(model.url)
  models.value = []
  if (window.__airiVisualDemo === probe)
    delete window.__airiVisualDemo
})
</script>

<template>
  <main :class="['p-4', 'grid gap-4', 'font-sans text-neutral-800 bg-neutral-100 min-h-screen']">
    <h1 :class="['text-xl font-bold']">
      AIRI visual presence · local dev gallery
    </h1>
    <p>Choose all corpus files. Model data stays local and is released when this page closes.</p>
    <input data-testid="corpus-files" type="file" accept=".vrm" multiple :disabled="running" @change="chooseFiles">
    <div :class="['flex flex-wrap gap-3 items-center']">
      <select :value="selected" aria-label="Avatar" :disabled="running" @change="selectModel(Number(($event.target as HTMLSelectElement).value))">
        <option v-for="(model, index) in models" :key="model.url" :value="index">
          {{ model.name }}
        </option>
      </select>
      <label>Idle intensity <select v-model="intensity" aria-label="Idle intensity"><option v-for="level in levels" :key="level">{{ level }}</option></select></label>
      <label>Activity <select v-model="activity" aria-label="Activity"><option v-for="value in activities" :key="value">{{ value }}</option></select></label>
      <label><input v-model="speechBlock" type="checkbox">Speaking owner</label>
      <label><input v-model="manualBlock" type="checkbox">Manual owner</label>
      <button @click="scene?.setExpression('happy', 0.4)">
        Native ACT interruption
      </button>
      <button @click="demonstrateIdle">
        Run idle for 3 minutes
      </button>
      <button @click="stopDemo">
        Stop / cancel
      </button>
      <button :disabled="running || !models.length" @click="runCorpus">
        Run corpus twice
      </button>
    </div>
    <p data-testid="status">
      {{ status }}
    </p>
    <p data-testid="loaded">
      {{ loaded }} · dimensions {{ dimensions }} · visual pose pass {{ cpu.toFixed(4) }} ms/frame
    </p>
    <div data-testid="avatar-viewport" :class="['h-100 relative', 'rounded-xl bg-neutral-200 overflow-hidden']">
      <ThreeScene v-if="current" ref="scene" :model-id="current.name" :model-src="current.url" :idle-animation="animations.idleLoop.href" @error="status = 'Renderer error. Inspect local diagnostics.'" />
    </div>
    <section :class="['grid gap-2']">
      <h2 :class="['font-bold']">
        RAW NATIVE EXPRESSIONS
      </h2>
      <p>Pure native channels. Blink and mouth shapes stay independent of body gestures.</p>
      <div :class="['flex flex-wrap gap-2']">
        <button v-for="name in expressions" :key="name" :data-native-expression="name" :disabled="running" @click="previewExpression(name)">
          {{ name }}
        </button>
      </div>
    </section>
    <section :class="['grid gap-2']">
      <h2 :class="['font-bold']">
        EMBODIED EMOTIONS
      </h2>
      <p>Face, head, torso, shoulders, arms, and hands act together.</p>
      <div :class="['flex flex-wrap gap-2']">
        <button v-for="emotion in embodiedEmotions" :key="emotion.label" :data-embodied-emotion="emotion.behavior" :disabled="running" @click="playBehavior(emotion.behavior)">
          {{ emotion.label }}
        </button>
      </div>
    </section>
    <section :class="['grid gap-2']">
      <h2 :class="['font-bold']">
        MOTION REVIEW
      </h2>
      <div :class="['flex flex-wrap gap-4 items-center']">
        <label><input v-model="bodyGestures" type="checkbox">Body gestures ON / OFF</label>
        <label>Body amplitude {{ bodyAmplitude.toFixed(2) }} <input v-model.number="bodyAmplitude" aria-label="Body amplitude" type="range" min="0" max="1.5" step="0.05"></label>
        <label>Arm amplitude {{ armAmplitude.toFixed(2) }} <input v-model.number="armAmplitude" aria-label="Arm amplitude" type="range" min="0" max="1.5" step="0.05"></label>
        <label>Hand amplitude {{ handAmplitude.toFixed(2) }} <input v-model.number="handAmplitude" aria-label="Hand amplitude" type="range" min="0" max="1.5" step="0.05"></label>
        <label>Transition speed {{ transitionSpeed.toFixed(2) }} <input v-model.number="transitionSpeed" aria-label="Transition speed" type="range" min="0.5" max="2" step="0.1"></label>
      </div>
    </section>
    <h2 :class="['font-bold']">
      VISUAL BEHAVIOR CATALOG · 30 BEHAVIORS
    </h2>
    <div :class="['flex flex-wrap gap-2']">
      <button v-for="name in behaviorNames" :key="name" :data-behavior="name" :disabled="running" @click="playBehavior(name)">
        {{ name }}
      </button>
      <button @click="controller.returnToNeutral()">
        Return to neutral
      </button>
    </div>
    <p>Native motion: upstream retargeted idle_loop.vrma. The corpus contains no embedded motion clips.</p>
    <button @click="controller.stop()">
      Play native idle_loop only
    </button>
    <pre v-if="result" data-testid="corpus-result" :class="['text-xs overflow-auto max-h-80']">{{ JSON.stringify(result, null, 2) }}</pre>
  </main>
</template>

<style scoped>
button, select { padding: 0.35rem 0.65rem; border: 1px solid #aaa; border-radius: 0.5rem; background: white; }
button:disabled { opacity: 0.5; }
</style>
