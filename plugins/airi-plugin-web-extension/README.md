# AIRI Plugin - Web Extension

> Read what you are reading!

This is a plugin for the AIRI to understand what you are reading, looking at, or listening to on the web.

## What it does now

- Captures page + video context from YouTube and Bilibili.
- Captures Jellyfin Web playback on origins that you allow in the popup (Jellyfin sites). It sends the web client's device id and the item id from the stream path, so AIRI's Core can match the page with its Jellyfin server session. It never reads stored credentials or sends stream URLs.
- Extracts subtitles from text tracks or DOM overlays. On Jellyfin it reads only the track that Jellyfin shows, and keeps multi-line and secondary lines.
- Sends an update marked `isStopped` when the page removes its player, and starts a new stream for the next playback.
- Sends context updates and optional `spark:notify` events to the character.
- Stamps each video and subtitle update with its stream, sequence, read time, playback timeline, tab, and server connection. Consumers such as the Companion Core watch use the stamp to drop delayed or replayed updates.
- Sends an update at once on a seek and on the end of a video. A caption overlay that disappears sends an empty caption marked `cleared`.
- Exposes a popup to configure WebSocket, toggles, and quick status.

## Quick start

1. `pnpm -F @proj-airi/airi-plugin-web-extension dev`
2. Load the unpacked extension from `.wxt/dev` in your browser.
3. Open the popup to set the WebSocket URL (default: `ws://localhost:6121/ws`).
4. Watch a YouTube/Bilibili video and confirm the popup shows the detected title/subtitle.
