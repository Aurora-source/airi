# AIRI Plugin - Web Extension

> Read what you are reading!

This is a plugin for the AIRI to understand what you are reading, looking at, or listening to on the web.

## What it does now

- Captures page + video context from YouTube and Bilibili.
- Extracts subtitles from text tracks or DOM overlays.
- Sends context updates and optional `spark:notify` events to the character.
- Stamps each video and subtitle update with its stream, sequence, read time, playback timeline, tab, and server connection. Consumers such as the Companion Core watch use the stamp to drop delayed or replayed updates.
- Sends an update at once on a seek and on the end of a video. A caption overlay that disappears sends an empty caption marked `cleared`.
- Exposes a popup to configure WebSocket, toggles, and quick status.

## Quick start

1. `pnpm -F @proj-airi/airi-plugin-web-extension dev`
2. Load the unpacked extension from `.wxt/dev` in your browser.
3. Open the popup to set the WebSocket URL (default: `ws://localhost:6121/ws`).
4. Watch a YouTube/Bilibili video and confirm the popup shows the detected title/subtitle.
