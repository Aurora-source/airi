import type { VisualActivity } from '@proj-airi/model-driver-visual'
import type { VrmFrameRuntimeHook } from '@proj-airi/stage-ui-three/composables/vrm'
import type { Ref } from 'vue'

import { onScopeDispose, watch } from 'vue'

import { VisualPresenceHost } from '../libs/visual-presence/host'
import { useModsServerChannelStore } from '../stores/mods/api/channel-server'

/** The VRM scene seam that ThreeScene exposes. */
export interface VisualPresenceScene {
  setVrmFrameHook: (hook?: VrmFrameRuntimeHook) => void
  setVrmExpressionFrameHook: (hook?: VrmFrameRuntimeHook) => void
}

/**
 * Connects the Vivid visual behavior controller to the stage's VRM scene and to the server channel.
 * The stage owns one host. A model or renderer change releases the old model first. Unmount removes both hooks.
 *
 * Remote modules, for example the Core's Director, send `output:visual:request` and `output:visual:cancel`.
 * The stage answers with `output:visual:result` and reports availability with `output:visual:state`.
 */
export function useStageVisualPresence(options: {
  scene: Ref<VisualPresenceScene | undefined>
  /** False for other renderers and while the stage is paused. */
  enabled: Ref<boolean>
  modelSrc: Ref<string | undefined>
  modelId: Ref<string | undefined>
  speaking: Ref<boolean>
  localActivity: Ref<VisualActivity | undefined>
}) {
  const channel = useModsServerChannelStore()
  const host = new VisualPresenceHost({
    modelSrc: () => options.enabled.value ? options.modelSrc.value : undefined,
    modelId: () => options.modelId.value ?? 'stage',
    onState: (state) => {
      if (channel.connected)
        channel.send({ type: 'output:visual:state', data: state })
    },
  })

  watch(options.scene, (next, previous) => {
    previous?.setVrmFrameHook(undefined)
    previous?.setVrmExpressionFrameHook(undefined)
    next?.setVrmFrameHook(host.frame)
    next?.setVrmExpressionFrameHook(host.expressionFrame)
  }, { flush: 'post', immediate: true })
  // Upstream disposes the old model after a change, so the host lets go of it first.
  watch([options.modelSrc, options.enabled], () => host.release(), { flush: 'sync' })
  watch(options.speaking, speaking => host.setSpeaking(speaking), { immediate: true })
  watch(options.localActivity, activity => host.setLocalActivity(activity), { immediate: true })
  watch(() => channel.connected, (connected) => {
    if (connected)
      host.republish()
  })

  const stops = [
    channel.onEvent('output:visual:request', (event) => {
      const result = host.request(event.data)
      if (channel.connected)
        channel.send({ type: 'output:visual:result', data: { requestId: event.data.requestId, result } })
    }),
    channel.onEvent('output:visual:cancel', event => host.cancel(event.data.requestId)),
  ]

  onScopeDispose(() => {
    stops.forEach(stop => stop())
    options.scene.value?.setVrmFrameHook(undefined)
    options.scene.value?.setVrmExpressionFrameHook(undefined)
    host.dispose()
  })

  return {
    host,
    /** A manual model action owns the model for a short time. */
    noteManualControl: (durationMs = 1500) => host.noteManualControl(durationMs),
  }
}
