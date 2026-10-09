import type { VRMCore } from '@pixiv/three-vrm-core'
import type { Profile, WLipSyncAudioNode, WLipSyncVowel } from '@proj-airi/model-driver-lipsync/shared/wlipsync'
import type { Ref } from 'vue'

import { createWLipSyncNode } from '@proj-airi/model-driver-lipsync/runtime/wlipsync'
import {
  createWLipSyncVowelDriver,
  WLIP_SYNC_VOWELS,
  wlipsyncProfile,
} from '@proj-airi/model-driver-lipsync/shared/wlipsync'
import { ref, shallowRef, watch } from 'vue'

const VRM_EXPRESSION_BY_VOWEL: Record<WLipSyncVowel, string> = {
  A: 'aa',
  E: 'ee',
  I: 'ih',
  O: 'oh',
  U: 'ou',
}

/** What the vowel driver reads after the source ended. */
const SILENT_FRAME = { volume: 0, weights: {} }

/**
 * Applies shared wLipSync vowel weights to a VRM expression manager.
 *
 * The caller owns the AudioContext and audio source lifecycle. This composable
 * owns only the connection between that source and its wLipSync node.
 */
export function useVRMLipSync(
  audioContext: Readonly<Ref<AudioContext | undefined>>,
  audioSource: Readonly<Ref<AudioBufferSourceNode | undefined>>,
) {
  const isLipSyncActive = ref(false)
  const lipSyncNode = shallowRef<WLipSyncAudioNode>()
  const vowelDriver = createWLipSyncVowelDriver()
  let sourcePlaying = false

  watch(audioContext, (context, _, onCleanup) => {
    lipSyncNode.value = undefined
    vowelDriver.reset()
    isLipSyncActive.value = false
    if (!context)
      return

    let active = true
    let createdNode: undefined | WLipSyncAudioNode
    onCleanup(() => {
      active = false
      createdNode?.disconnect()
    })

    void createWLipSyncNode(context, wlipsyncProfile as Profile)
      .then((node) => {
        createdNode = node
        if (!active) {
          node.disconnect()
          return
        }
        lipSyncNode.value = node
      })
      .catch((error) => {
        if (active)
          console.error('[stage-ui-three] Failed to create the VRM lip-sync node.', error)
      })
  }, { immediate: true })

  watch([lipSyncNode, audioSource], ([node, source], _, onCleanup) => {
    sourcePlaying = false
    if (!node || !source)
      return

    try {
      source.connect(node)
    }
    catch (error) {
      console.error('[stage-ui-three] Failed to connect the VRM lip-sync node.', error)
      return
    }

    sourcePlaying = true
    const onEnded = () => {
      sourcePlaying = false
    }
    source.addEventListener('ended', onEnded)

    onCleanup(() => {
      source.removeEventListener('ended', onEnded)
      try {
        source.disconnect(node)
      }
      catch {
        // The source can end before Vue runs this watcher cleanup.
      }
    })
  }, { immediate: true })

  function update(vrm?: VRMCore, delta = 0.016) {
    const node = lipSyncNode.value
    if (!vrm?.expressionManager || !node) {
      isLipSyncActive.value = false
      return
    }

    // NOTICE:
    // The wLipSync worklet posts no frame once its input stops, so the node keeps its last vowel weights.
    // The mouth then stays open after speech, and lip sync never reports silence.
    // Source: node_modules/wlipsync/dist/audio-processor.js process() returns early without an input channel.
    // Removal condition: wLipSync reports silence when its input ends.
    const weights = vowelDriver.update(sourcePlaying ? node : SILENT_FRAME, delta)
    let hasActiveVisemes = false
    for (const vowel of WLIP_SYNC_VOWELS) {
      const weight = weights[vowel]
      if (weight > 0.01)
        hasActiveVisemes = true
      vrm.expressionManager.setValue(VRM_EXPRESSION_BY_VOWEL[vowel], weight)
    }

    isLipSyncActive.value = hasActiveVisemes
  }

  return {
    isLipSyncActive,
    update,
  }
}
