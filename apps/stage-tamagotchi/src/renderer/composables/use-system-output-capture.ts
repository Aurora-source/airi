import type { SerializableDesktopCapturerSource } from '@proj-airi/electron-screen-capture'

import { mediaStreamSource } from '@proj-airi/audio/browser'
import { setupElectronScreenCapture } from '@proj-airi/electron-screen-capture/renderer'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'
import { useModsServerChannelStore } from '@proj-airi/stage-ui/stores/mods/api/channel-server'
import { useLocalStorage } from '@vueuse/core'
import { onScopeDispose, watch } from 'vue'

import { SystemOutputCaptureProvider } from '../features/companion/system-output-capture'

/** Speech recognition takes 16 kHz audio. The audio context resamples the loopback stream to it. */
const SAMPLE_RATE = 16_000

/**
 * Serves short system output recordings to the Companion Core watch, while the user allows it and the server channel
 * is connected. It is off by default: `settings/companion/system-output-capture` must be `true`.
 *
 * The audio comes from Electron's desktop loopback, the same source as the Live2D system audio lip sync. It is the
 * sound of the computer, never the microphone. A reconnect registers the provider again, because the server forgets
 * consumers of a closed connection.
 */
export function useSystemOutputCapture() {
  const allowed = useLocalStorage('settings/companion/system-output-capture', false)
  const channel = useModsServerChannelStore()
  const screenCapture = setupElectronScreenCapture(getElectronEventaContext())
  let provider: SystemOutputCaptureProvider | undefined

  async function openSystemOutput(): Promise<MediaStream> {
    const stream = await screenCapture.selectWithSource(
      (sources: SerializableDesktopCapturerSource[]) => {
        if (sources.length === 0)
          throw new Error('No screen source available')
        return sources[0].id
      },
      () => navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }),
      { sourcesOptions: { types: ['screen'] } },
    )
    for (const track of stream.getVideoTracks()) {
      track.stop()
      stream.removeTrack(track)
    }
    if (stream.getAudioTracks().length === 0) {
      stream.getTracks().forEach(track => track.stop())
      throw new Error('No system audio track available')
    }
    return stream
  }

  function openPcm(stream: MediaStream, signal: AbortSignal) {
    const context = new AudioContext({ sampleRate: SAMPLE_RATE })
    signal.addEventListener('abort', () => void context.close().catch(() => {}), { once: true })
    return mediaStreamSource(stream, context).open(signal)
  }

  function stop() {
    provider?.stop()
    provider = undefined
  }

  watch([allowed, () => channel.connected], ([on, connected]) => {
    stop()
    if (!on || !connected)
      return
    provider = new SystemOutputCaptureProvider({ channel, openSystemOutput, openPcm })
    provider.start()
  }, { immediate: true })

  onScopeDispose(stop)
}
