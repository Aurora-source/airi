import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed } from 'vue'

/** Selects automatic listening or explicit activation. Wake-word capture requires a detector. */
export type VoiceInputMode = 'continuous' | 'wake-word' | 'push-to-talk'
export type VoiceOutputDevice = 'headphones' | 'speakers'

/** Persists the listening policy. Speaker output keeps playback echo suppression active. */
export const useVoiceInputPolicyStore = defineStore('voice-input-policy', () => {
  const mode = useLocalStorage<VoiceInputMode>('settings/voice-input/mode', 'continuous')
  const outputDevice = useLocalStorage<VoiceOutputDevice>('settings/voice-input/output-device', 'headphones')
  const automaticListeningEnabled = computed(() => mode.value === 'continuous')
  const bargeInEnabled = computed(() => automaticListeningEnabled.value && outputDevice.value === 'headphones')

  return { mode, outputDevice, automaticListeningEnabled, bargeInEnabled }
})
