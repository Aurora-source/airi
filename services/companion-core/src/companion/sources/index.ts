import type { MediaSourcesConfig } from '../../config/config'
import type { MediaSourceAdapter } from '../../watch/sources'
import type { HostLookup } from './network'

import { JellyfinAdapter } from './jellyfin'
import { listeningAddresses } from './listening'
import { MpvAdapter } from './mpv'
import { serverBase } from './network'
import { VlcAdapter } from './vlc'

export { JellyfinAdapter } from './jellyfin'
export { deviceIdOf, JellyfinClient } from './jellyfin-client'
export { listeningAddresses } from './listening'
export { MpvAdapter } from './mpv'
export { checkServer, isPrivateAddress, serverBase } from './network'
export type { HostLookup } from './network'
export { VlcAdapter } from './vlc'

/** Credentials that the runtime read from the protected secret store. They stay inside the adapters. */
export interface MediaSourceSecrets {
  jellyfinToken?: string
  vlcPassword?: string
}

/**
 * Builds the enabled desktop player and media server sources. A disabled source is never created, so it never
 * connects, polls, or opens a pipe.
 */
export function createMediaSources(config: MediaSourcesConfig, secrets: MediaSourceSecrets, options: { now: () => number, hostname: string, lookup: HostLookup, report?: (message: string) => void }): MediaSourceAdapter[] {
  const sources: MediaSourceAdapter[] = []
  if (config.jellyfin.enabled && config.jellyfin.url) {
    sources.push(new JellyfinAdapter({
      base: serverBase(config.jellyfin.url),
      token: secrets.jellyfinToken,
      now: options.now,
      hostname: options.hostname,
      lookup: options.lookup,
      followThisComputer: config.jellyfin.followThisComputer,
      devices: config.jellyfin.devices,
      serverSubtitles: config.jellyfin.serverSubtitles,
      report: options.report,
    }))
  }
  if (config.mpv.enabled && config.mpv.pipes.length > 0)
    sources.push(new MpvAdapter({ endpoints: config.mpv.pipes.map(pipe => ({ pipe: pipe.name, player: pipe.player })), now: options.now, report: options.report }))
  if (config.vlc.enabled)
    sources.push(new VlcAdapter({ port: config.vlc.port, password: secrets.vlcPassword, now: options.now, report: options.report, listening: listeningAddresses }))
  return sources
}
