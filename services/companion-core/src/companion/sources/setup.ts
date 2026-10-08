import type { MediaSourcesConfig } from '../../config/config'

/**
 * The exact player settings for the configured sources, as lines for `companion-core watch-setup`.
 * The Core never writes player settings itself. The user applies these lines, so nothing changes without consent.
 */
export function watchSetupLines(config: MediaSourcesConfig): string[] {
  const lines: string[] = ['Watch sources (companion-core.json > watch.sources). Each source is off until "enabled": true.', '']
  const mpvPipes = config.mpv.pipes.filter(pipe => pipe.player === 'mpv')
  const jmpPipes = config.mpv.pipes.filter(pipe => pipe.player === 'jellyfin-media-player')
  lines.push(`mpv: ${config.mpv.enabled ? 'enabled' : 'off'}`)
  for (const pipe of mpvPipes) {
    lines.push(`  Add this line to %APPDATA%\\mpv\\mpv.conf:  input-ipc-server=\\\\.\\pipe\\${pipe.name}`)
    lines.push(`  Or start mpv for one session:  mpv --input-ipc-server=\\\\.\\pipe\\${pipe.name} <file>`)
  }
  if (mpvPipes.length === 0)
    lines.push('  No pipe with "player": "mpv" is configured.')
  lines.push('')
  lines.push(`Jellyfin Media Player (mpv pipe): ${config.mpv.enabled && jmpPipes.length > 0 ? 'enabled' : 'off'}`)
  for (const pipe of jmpPipes) {
    lines.push(`  In Jellyfin Media Player, open the user menu > Client Settings, and add this line to "Manual MPV Configuration":  input-ipc-server=\\\\.\\pipe\\${pipe.name}`)
    lines.push(`  Or create %LOCALAPPDATA%\\JellyfinMediaPlayer\\mpv.conf with that line. Restart the app after the change.`)
  }
  if (jmpPipes.length === 0)
    lines.push('  Add { "name": "jmp-airi", "player": "jellyfin-media-player" } to watch.sources.mpv.pipes to read subtitles from it.')
  lines.push('')
  lines.push(`VLC: ${config.vlc.enabled ? 'enabled' : 'off'}`)
  lines.push(`  Start VLC with:  vlc.exe --extraintf=http --http-host=127.0.0.1 --http-port=${config.vlc.port}`)
  lines.push('  Without --http-host=127.0.0.1, VLC listens on every network interface.')
  lines.push('  Set the password in Tools > Preferences > All > Interface > Main interfaces > Lua > Lua HTTP > Password.')
  lines.push(`  Then store it:  set VLC_HTTP_PASSWORD=<password>  and  companion-core secret-import ${config.vlc.passwordRef} --from-env VLC_HTTP_PASSWORD`)
  lines.push('  VLC reports no subtitle text over HTTP. Watch uses captionless rules for VLC.')
  lines.push('')
  lines.push(`Jellyfin server: ${config.jellyfin.enabled ? 'enabled' : 'off'}${config.jellyfin.url ? ` (${config.jellyfin.url})` : ''}`)
  lines.push('  Set watch.sources.jellyfin.url to your server, then run:  companion-core jellyfin-connect')
  lines.push(`  Followed: ${config.jellyfin.followThisComputer ? 'Jellyfin Media Player on this computer' : 'no device by itself'}${config.jellyfin.devices.length > 0 ? `, and ${config.jellyfin.devices.join(', ')}` : ''}. Other devices need an Ops selection.`)
  lines.push('  Jellyfin Web: open the extension popup on your Jellyfin page and allow it as a Jellyfin site.')
  return lines
}
