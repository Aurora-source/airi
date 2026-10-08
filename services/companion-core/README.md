# @proj-airi/companion-core

Companion Core is a local service that sits between AIRI and cloud model providers.
The **Companion Gateway** is its first part. It gives AIRI one stable OpenAI-compatible endpoint, and it chooses the model behind it.
It also forwards audio transcriptions to a speech-recognition provider.

## What it does

- Listens on `127.0.0.1` only. The default port is `11980`.
- Serves `POST /v1/chat/completions` and `GET /v1/models` to AIRI's **OpenAI Compatible** chat provider.
- Maps a stable alias, for example `companion-chat`, to an ordered **chain** of models from configuration.
- Counts the tokens of each request by part: system, conversation, tool schemas, and output reserve.
- Checks each model before it sends anything: capabilities, request size, rate limits, quota, and recent failures.
- Trims old history by whole units. A tool call always stays with its results.
- Moves to the next model when one fails **before** the client received a byte. It never continues a started answer with another model.
- Keeps a conversation on the model that serves it, because another model can change the character.
- Tracks requests and tokens per key and model in SQLite, next to the limits that each provider reports.
- Tests each model with live probes and uses the results in place of the configured capabilities.
- Streams the provider response back byte for byte. Tool calls, finish reasons, usage, and provider errors pass through unchanged.
- Aborts the provider request when AIRI cancels.
- Keeps provider API keys out of AIRI. AIRI holds only a local gateway token.

It also holds long-term memory and, when you turn it on, watches the screen. See [Memory](#memory) and [Perception](#perception).
It does **not** run a Director or start local services. Those parts come in later phases.

## Configuration

The file is `%LOCALAPPDATA%\AIRI-Companion\companion-core.json`. Provider and model names are data, so a new model is an edit and not a code change.

| Section | Content |
| --- | --- |
| `profile` | `local`, `cloud`, `cloud-mura-voice` (default), or `hybrid`. It decides which models a chain can hold. |
| `providers` | `baseURL`, `keyRef`, optional `compat: "gemini"`, and `locality` (`cloud` or `local`). |
| `models` | One entry per model: `provider`, the provider's `model` name, `capabilities`, and published `limits`. |
| `aliases` | A `role`, an ordered `chain` of model ids, and the prompt targets. |
| `routing` | Sticky time, first-byte timeout, cool-downs, and the token safety margin. |
| `audio` | Upload, response, and deadline bounds for transcription. |
| `store` | The SQLite file. It defaults to `companion-core.sqlite` next to the configuration. |
| `memory`, `channel` | Long-term memory and the AIRI server channel. See [Memory](#memory). |
| `perception` | Screen capture, privacy lists, and the vision alias. Off by default. See [Perception](#perception). |

```json
{
  "profile": "cloud-mura-voice",
  "providers": {
    "gemini": { "baseURL": "https://generativelanguage.googleapis.com/v1beta/openai/", "keyRef": "provider-gemini", "compat": "gemini" },
    "groq": { "baseURL": "https://api.groq.com/openai/v1/", "keyRef": "provider-groq" }
  },
  "models": {
    "gemini-flash-lite": {
      "provider": "gemini",
      "model": "gemini-3.5-flash-lite",
      "capabilities": { "contextWindow": 1048576, "tools": true, "images": true },
      "limits": { "rpm": 15, "rpd": 500, "dayReset": { "timeZone": "America/Los_Angeles" } }
    },
    "groq-oss-120b": {
      "provider": "groq",
      "model": "openai/gpt-oss-120b",
      "capabilities": { "contextWindow": 131072, "tools": true },
      "limits": { "tpm": 8000, "tpd": 200000 }
    }
  },
  "aliases": { "companion-chat": { "chain": ["gemini-flash-lite", "groq-oss-120b"] } }
}
```

The chain order is a decision, not a guess. Run the persona benchmark and use its result.

A model entry can also set `styleReminder`. The gateway adds that text to the end of the system prompt for that model only. Use it for a format rule that the model breaks, for example the closing of ACT tokens. It is off by default.

## Compute profiles

| Profile | Models in a chain |
| --- | --- |
| `local` | Local models only. |
| `cloud`, `cloud-mura-voice` | Cloud models only. An exhausted chain is a visible error. It never starts local inference. |
| `hybrid` | Cloud models first. A local model is allowed only after every cloud model. |

Configuration loading rejects a chain that breaks its profile. The router checks again, so a bad state cannot start local inference.

## How a request is routed

1. The router lists the models of the alias chain. A model name `alias:model` pins one model and allows no fallback.
2. Each model gets a preflight. It names the reason when the model cannot take the request, for example `TPM_INELIGIBLE` or `RPD_EXHAUSTED`.
3. A request that offers tools can grow a second request that carries the tool result. The preflight sizes the **whole turn** against the per-minute token limit.
4. A model that carries the whole turn comes first. A model that carries only the first round comes after every other model.
5. Inside each group, the model that already serves the conversation comes first.
6. A model that failed recently moves behind the healthy models. A model that hit a rate limit gets no traffic until its time passes.
7. The gateway sends the request to each candidate in order. Only a failure before the first byte moves it on.

A request that is too large for a provider is **ineligible**. It is never counted as an unhealthy provider.

## Diagnostics

- Each answer carries `x-companion-model`, `x-companion-tier`, `x-companion-attempts`, and `x-companion-skipped`. They hold ids and reasons only.
- `GET /ops/status` with the **ops token** shows the limits, usage, cool-downs, health, sticky choices, and the last routed requests.
- Each log line holds the model, outcome, timing, and token counts. It never holds message text.

## Probes

```powershell
pnpm -F @proj-airi/companion-core cli probe
pnpm -F @proj-airi/companion-core cli probe groq-qwen --deep
```

A probe checks that the model exists and tests streaming, tool calls, image input, and structured output. It records the first-byte time and the rate-limit headers.
`--deep` also finds the largest prompt that the provider accepts. It costs quota, and a refusal by a per-minute limit does not lower the prompt limit.
A cloud profile never probes a local model, because the request loads that model into memory.

## Persona benchmark

The benchmark runs thirty scenes on the models of an alias. It uses AIRI's default character, or a card file that you pass.

```powershell
pnpm -F @proj-airi/companion-core persona run --out <directory> --models gemini-flash-lite,groq-qwen
pnpm -F @proj-airi/companion-core persona judge --out <directory>
pnpm -F @proj-airi/companion-core persona report --out <directory>
pnpm -F @proj-airi/companion-core persona score-blind --out <directory> --ranks persona-blind-ranks.json
```

- Automatic checks cover ACT tokens, AI disclaimers, assistant phrases, length, reasoning in the reply, character voice, copied prompt text, and tool use.
- A judge from **another provider** scores each answer. `--only <model>` makes one judge score every answer, so that all models share one scale. `--file <name>` keeps a separate judgment set.
- A refused request has no reply. It counts in the failure rate and not as a broken format.
- `report --blind-models a,b,c` writes `blind-ranking.html` for the finalists and a sealed `key.json`. Rank the answers in the page without the key, then score the export.
- `--reminder <text>` adds a last instruction to the system prompt. Use it to test a `styleReminder` before you put it in the configuration.

## Provider compatibility

A provider entry can set `"compat": "gemini"`. Two things change for that provider:

- The Gemini endpoint omits `index` on streamed tool-call fragments. OpenAI clients, including AIRI's xsAI client, drop such tool calls. The adapter restores a stable `index` for each call `id`.
- Gemini 3 rejects a tool call in the history that has no thought signature. After a failover, the history can hold calls that another model wrote. The adapter adds a placeholder signature to those calls only.

Without `compat`, the gateway forwards requests and responses unchanged.

## Security

| Control | Behavior |
| --- | --- |
| Binding | `127.0.0.1` only. The configuration rejects any other host. |
| Tokens | Two bearer tokens. The inference token works on `/v1/*`. The ops token works on `/ops/*`. Neither works on the other. |
| Storage | Tokens and provider keys are Windows DPAPI blobs in `%LOCALAPPDATA%\AIRI-Companion\secrets\`. |
| Host | The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`. This blocks DNS-rebinding pages. |
| Origin | A request with an `Origin` header must match `allowedOrigins` exactly, even with a valid token. |
| Logs | One metadata line per request. Headers, bodies, prompts, images, and credentials are never logged. Known secrets and key-shaped strings are redacted. |
| No token | Only `GET /livez`. It returns `{"ok":true}` and nothing else. |
| Memory | The database folder grants access to the current Windows user only. Memory administration needs the ops token. Memory tools need the inference token. |
| Screen | Frames stay in memory and go only to the selected vision model. Window titles, screen text, and image bytes are never logged. The capture helper is Windows PowerShell from its absolute System32 path. |

## How to use

1. Create the starter configuration and the gateway tokens:

   ```powershell
   pnpm -F @proj-airi/companion-core cli init
   ```

2. Store each provider key. Set an environment variable first, then import it. The command never prints the value.

   ```powershell
   pnpm -F @proj-airi/companion-core cli secret-import provider-gemini --from-env GEMINI_API_KEY
   ```

3. Edit the configuration file. Then test the models:

   ```powershell
   pnpm -F @proj-airi/companion-core cli probe
   ```

4. Start the gateway:

   ```powershell
   pnpm -F @proj-airi/companion-core start
   ```

5. In AIRI, open **Settings > Providers > Chat > OpenAI Compatible**:
   - Base URL: `http://127.0.0.1:11980/v1/`
   - API key: the output of `pnpm -F @proj-airi/companion-core cli token`
   - Model: `companion-chat`

To pin one model from AIRI's model list, choose `companion-chat:<model id>`.

## Audio transcription

Speech recognition uses the same configuration file, providers, keys, and profile as chat.
An alias with `"role": "speech-recognition"` serves `POST /v1/audio/transcriptions`. Its `chain` lists the speech models, best first.
Without such an alias, transcription is off and the endpoint returns `503 audio_not_configured`.

```json
{
  "profile": "cloud-mura-voice",
  "providers": {
    "groq": { "baseURL": "https://api.groq.com/openai/v1/", "keyRef": "provider-groq" }
  },
  "models": {
    "groq-whisper-turbo": { "provider": "groq", "model": "whisper-large-v3-turbo", "capabilities": { "contextWindow": 448, "streaming": false, "tools": false } },
    "groq-whisper": { "provider": "groq", "model": "whisper-large-v3", "capabilities": { "contextWindow": 448, "streaming": false, "tools": false } }
  },
  "aliases": {
    "companion-stt": { "role": "speech-recognition", "chain": ["groq-whisper-turbo", "groq-whisper"] }
  }
}
```

Groq reports a 448-token context for Whisper. Speech recognition ignores `capabilities`, but the model schema requires them.

The compute profile limits the speech chain like any other chain:

| Profile | Speech models |
| --- | --- |
| `cloud`, `cloud-mura-voice` | Cloud models only. Configuration loading rejects a local speech model. |
| `local` | Local models only. Companion Core does not start their inference server. |
| `hybrid` | Cloud models first. A local model after every cloud model is the explicit fallback. |

A local speech provider needs a literal `127.0.0.1` or `[::1]` base URL. Redirects fail.

Fallback rules:

- A cloud model moves on to the next cloud model only when the provider reports that model as unavailable.
- A cloud rate limit returns its status and `Retry-After`. It never spends the quota of another cloud model.
- A local model in the chain handles cloud rate limits, outages, and network failures.
- A cloud model without its key is skipped. A chain with no usable model returns `503 audio_provider_key_missing`.

The speech alias appears in `GET /v1/models` without `alias:model` pins. A chat request to it returns `400 model_not_supported`, and probes skip its models.

In AIRI's OpenAI-compatible transcription provider, set the gateway base URL, inference token, and model `companion-stt`.
`POST /v1/audio/transcriptions` accepts multipart `file` and `model` fields. The `model` field names the alias. URL input is rejected.
Optional fields are `language` (ISO 639-1), `prompt`, `temperature` (0–1), and `response_format` (`json`, `text`, or `verbose_json`).
Each request keeps audio in memory. Filenames change to `audio.<format>`, while the audio bytes and format stay intact.

The `audio` section sets the bounds. The defaults are `timeoutMs: 15000`, `maxRequestBytes: 26214400`, and `maxResponseBytes: 1048576`.
The upload limit includes multipart headers. One deadline covers upload, fallback attempts, and the complete provider response.
Client cancellation stops upload or the provider request. Logs contain metadata, with no audio, transcript, prompt, or key.

## Memory

The R4 memory subsystem (`src/memory`, see its README) runs next to the gateway in the same process.
`memory.enabled` is on by default. The database is `memory/companion-memory.sqlite` in the Core home.

| Part | Behavior |
| --- | --- |
| Identity | AIRI sends `x-airi-session-id`, `x-airi-round-id`, and `x-airi-character-id` to this gateway. A request without them gets no memory and is not observed. |
| Recall | Runs once per AIRI round, before routing, with a 150 ms deadline. A miss, timeout, or failure sends the request without memory. |
| MemoryUnit | One `user`-role block directly before the current turn. The budgeter trims older history first and drops the block whole when only the fixed part fits. |
| Gateway observer | A fully delivered answer becomes provisional evidence: the user message once per round, the final answer once per turn. Interrupted answers are never observed. |
| Channel observer | Module `companion-core` on AIRI's server channel (`channel.url`). A persisted turn becomes authoritative evidence. R4 merges it with the provisional evidence into one event. |
| Consolidation | Idle only: no open chat request and 30 seconds since the last one. Interval `memory.consolidateEveryMs`. |
| Tools | `companion-core mcp` is a stdio MCP server with `memory_recall`, `memory_remember`, `memory_forget`, and `look_now`. Memory tools act for the configured user and the character of the newest AIRI turn. |
| Ops | `/ops/memory/status`, `items`, `search`, `items/edit`, `items/delete`, `items/forget`, `private`, `export`, `backup`, `consolidate`. |

To add the tools to AIRI desktop, add this server to `mcp.json` in AIRI's user data folder. Set `cwd` to this repository:

```json
{ "mcpServers": { "companion-core": { "command": "pnpm", "args": ["-F", "@proj-airi/companion-core", "cli", "mcp"], "cwd": "D:/AI/airi" } } }
```

## Perception

The R5 perception service (`src/perception`, see its README) gives the character a short-lived view of the screen.
It is off by default. Screen contents stay private: frames live in memory only and are never saved or logged.

| Part | Behavior |
| --- | --- |
| Switches | `perception.enabled` starts the capture helper and the `look_now` tool. `perception.ambient` adds periodic capture and automatic vision. Both are off by default. |
| Capture | One persistent Windows PowerShell helper (`src/companion/windows-capture.cs`) copies the primary display, downscales it to `maxWidth`, and encodes a JPEG in memory. A new resolution or display starts a new source generation. |
| Privacy | The R5 privacy gate checks each frame after capture, before each upload, and before the state is published. Paused perception, excluded apps and windows, locked or secure desktops, and private or sensitive windows are blocked. An app outside the classified list has unknown safety, so automatic upload is denied. |
| Change detection | A 64 by 36 luminance grid. A static screen never causes another vision request. `minimumIntervalMs` spaces automatic requests. |
| Vision | Requests go through the R2B router to the `visionAlias` alias, which needs role `vision`. Profile rules, capability checks, the quota ledger, health, and cool-downs apply. A local model answers only in a `hybrid` profile with `allowLocalFallback`. |
| NOW block | A fresh observation with confidence 0.5 or more becomes one `user`-role block of at most 1600 bytes, after the memory block. It names the app, never the window title. Expired state is never injected. The budgeter drops it before memory. |
| `look_now` | MCP tool and `POST /v1/companion/tools/look_now`. `authorize_unknown` allows an unclassified window for this call only. It never overrides a pause or a block. A call within 5 seconds of the last one reuses its result. |
| Memory | Policy `none`. Perception keeps event metadata in process for Ops: observation id, capture time, confidence, app, character, and session. No screen fact becomes long-term memory by itself. |
| Ops | `GET /ops/perception/status` and `POST /ops/perception/pause` with `{"paused": true}`. Both need the ops token. |

```json
{
  "aliases": { "companion-vision": { "role": "vision", "chain": ["gemini-flash-lite"] } },
  "perception": { "enabled": true, "ambient": false, "privacy": { "excludedApps": ["keepass"], "classifiedApps": ["myeditor"] } }
}
```

## Watch Together

The R6 watch subsystem (`src/watch`, see its README) follows the video that the AIRI browser extension reports, and
optionally mpv, VLC, and a Jellyfin server. It is on by default and needs AIRI's server channel. Captions, transcripts,
audio, file paths, and credentials are never saved or logged.

| Part | Behavior |
| --- | --- |
| Sources | The extension's `web:video` and `web:subtitle` context updates on the server channel, and the adapters in `src/companion/sources` (mpv, VLC, Jellyfin). Each source reports players with a connection, a sequence, a read time, and a playback timeline. Unstamped lane events are refused. |
| Source manager | `MediaSourceManager` groups players that show one playback (exact Jellyfin device and item ids, or the same title, episode, and position), selects one group, and gives one ordered update stream. Library identity beats player tags and file names. Direct player state beats server reports. Player subtitles beat server cues. |
| Sessions | One WatchState per selected group. Replacement, a manual selection, a player exit, a new extension connection, an extension exit, a lost channel, or two minutes of staleness ends the session. Late traffic of an ended player is refused. |
| Other devices | A Jellyfin session on another device, or of another user, is never followed by itself. Other users' sessions are dropped. Other devices of the user are listed in Ops and followed only after a selection or configuration. |
| Ordering | Older sequences, older timelines, reads older than the browser expiry, and producer times more than 2 s ahead are refused. A seek, a media change, or a new video element starts a new timeline. |
| Dialogue | Only the current caption is kept. A cleared overlay caption makes dialogue unknown. Timed cue ends, a pause, and VAD prove a gap. |
| Perception | A fresh R5 frame lends visual hints only when the playing app is in front: a browser, mpv, or VLC whose window title contains the media title, or Jellyfin Media Player. Stale, blocked, or unrelated frames clear the hints. A frame never sets playback, episode, or completion. |
| WATCH block | Fresh state becomes one `user`-role block of at most 1200 bytes, marked as untrusted media data. The budgeter drops NOW first, then WATCH, then memory. |
| Memory | Start, stop, a confirmed episode end, and shared moments go to R4 as `watch_milestone` events for the active character (`watch.memoryEvents`). R4 decides what stays. Captions, frames, and positions never go. |
| Completion | Only the media element's `ended` signal or mpv's end of file, accepted for the current media revision, confirms an episode end. VLC, the Jellyfin server, a stopped player, or a position near the end never do. |
| Reactions | `CompanionWatch.offerReaction` takes an external candidate. Admission needs fresh state, salience, a proven gap of 1.5 s, and the cooldown (`watch.reactionCooldownMs`, 3 minutes). The permit is checked again right before a Spark notification goes to the AIRI stage. User speech revokes it at once. |
| User speech | AIRI's `input:voice:activity` event, a microphone upload to `/v1/audio/transcriptions`, and a new user turn. |
| System audio | Off by default (`watch.systemAudio.enabled`). Only on an explicit `watch_listen` call, only while captions are missing, at most 8 s recorded after the call, through AIRI desktop's system output capture. Recognition uses the R3 route with the `watch.systemAudio.alias` alias, in English or Japanese. Fresh captions, user speech, a perception pause or block, a media change, or an extension exit cancel it. |
| AniList | Off by default (`watch.anilist.enabled`). `POST /ops/watch/anilist` binds a confirmed id and optional completed progress and curated context. The lookup asks for identity, titles, episode count, and duration only. Unknown progress withholds every spoiler-sensitive entry. |
| Tools | `watch_status` and `watch_listen` (MCP and `POST /v1/companion/tools/<name>`, inference token). |
| Ops | `GET /ops/watch/status`: media (id, site, player, title and its source, season, episode), playback and its source, freshness, dialogue state, source, and language, caption track, visual freshness, AniList, spoiler boundary, system audio, last reaction, cooldown, counters, and `sources` (adapters with connection, last sync, limitations, and error codes, followed players, the active group, the manual choice). `POST /ops/watch/source` with `{ "player": "<key>" }` follows one player, `{ "player": null }` returns to automatic selection. Ops token only. |

```json
{
  "aliases": { "companion-stt": { "role": "speech-recognition", "chain": ["groq-whisper-turbo"] } },
  "watch": {
    "enabled": true,
    "systemAudio": { "enabled": false, "alias": "companion-stt", "language": "en" },
    "anilist": { "enabled": false },
    "sources": {
      "jellyfin": { "enabled": false, "url": "https://media.example.com", "tokenRef": "jellyfin-token", "followThisComputer": true, "devices": [], "serverSubtitles": true },
      "mpv": { "enabled": false, "pipes": [{ "name": "airi-mpv", "player": "mpv" }, { "name": "jmp-airi", "player": "jellyfin-media-player" }] },
      "vlc": { "enabled": false, "port": 8080, "passwordRef": "vlc-http-password" }
    }
  }
}
```

### Desktop players and Jellyfin

`companion-core watch-setup` prints the exact player lines for the configured sources. The Core never writes player
settings, never starts or controls a player, and never searches the network for servers.

| Source | Reads | Subtitle text | Setup |
| --- | --- | --- | --- |
| mpv | JSON IPC pipe `\\.\pipe\<name>`: pause, speed, seek, file, tracks, `sub-text`. Read-only allowlist of `get_property` and `observe_property`. | Yes: the shown text, ASS dialogue without signs, multi-line, secondary line. Bitmap tracks: none. | `input-ipc-server=\\.\pipe\airi-mpv` in `mpv.conf`, or start mpv with that option. |
| Jellyfin Media Player | Its embedded mpv through the same pipe adapter (`"player": "jellyfin-media-player"`), plus its Jellyfin session. | Yes, through the pipe. Without the pipe: server cues. | User menu > Client Settings > Manual MPV Configuration: `input-ipc-server=\\.\pipe\jmp-airi`. |
| VLC | `http://127.0.0.1:<port>/requests/status.json` with the HTTP interface password. Never a command parameter. | No. VLC does not report it. Captions count as missing, so system audio can help on request. | `vlc.exe --extraintf=http --http-host=127.0.0.1 --http-port=8080`, password in VLC's Lua HTTP settings, then `companion-core secret-import vlc-http-password --from-env VLC_HTTP_PASSWORD`. Ops shows `http-open-to-network` when VLC listens beyond loopback. |
| Jellyfin server | `GET /Sessions` of the token's user, every 1.5 s while a session plays and 3 s otherwise. Series, season, episode, item id. Plot fields are never parsed. | Server cues: the cue at one instant of the selected text stream (`startPositionTicks = endPositionTicks = now`), only while no player reports text. | Set `url`, then `companion-core jellyfin-connect` (Quick Connect, no password). Plain http needs a host whose every address is private. |
| Jellyfin Web | The extension on an origin that the user allowed in its popup. Device id and item id link it to its server session. | Text tracks and Jellyfin's caption element. ASS and PGS draw on a canvas, so server cues fill in. | Extension popup > Jellyfin sites > Allow. |

### Ops API for a frontend

Companion Ops reads `GET /ops/watch/status` and writes `POST /ops/watch/source`, both with the ops token. The `sources`
object of the status has this shape. Titles are for the Ops user only. No caption, path, URL, or credential is in it.

```json
{
  "adapters": [{ "adapter": "mpv", "enabled": true, "connection": "connected", "lastSyncAt": 1791471059733, "players": 1, "limitations": ["ass-styles-unavailable"], "error": "EPIPE", "details": { "pipes": "airi-mpv", "versions": "v0.41.0" } }],
  "players": [{ "key": "mpv:airi-mpv", "kind": "mpv", "reach": "direct", "eligible": true, "group": "g1", "active": true, "playing": true, "title": "Sousou no Frieren", "episode": 13, "captions": { "form": "text", "language": "ja", "codec": "ass" }, "lastSeenMs": 420 }],
  "group": { "key": "g1", "session": 1, "members": ["mpv:airi-mpv", "jellyfin:<session>"], "playback": "mpv:airi-mpv", "dialogue": "mpv:airi-mpv", "timeline": 2, "waitingForIdentity": false, "identitySource": "metadata" },
  "manualSelection": null
}
```

`connection` is `connected`, `waiting` (no player or server reachable), `unauthorized` (missing or refused credential),
or `error` (see `error`). A player with `eligible: false` plays on another device and needs a `POST /ops/watch/source`.

## When to use it

- You want AIRI to use cloud models without storing provider keys in AIRI.
- You want one place for routing, quota tracking, and failover across free-tier providers.

## When not to use it

- You only use a local model. Point AIRI at Ollama directly.
- You need a provider that does not speak the OpenAI chat-completions protocol.
- You want to reach the gateway from another machine. It is loopback-only by design.

## Tests

```powershell
pnpm -F @proj-airi/companion-core exec vitest run
pnpm -F @proj-airi/companion-core typecheck
```

The tests use a fake provider for streaming, chunk boundaries, tool calls, images, provider errors, cancellation, authentication, Host and Origin checks, log redaction, and a DPAPI round trip.
They also cover token budgeting at every target size, whole-turn eligibility, the quota ledger, failover before and after the first byte, stickiness, compute profiles, probes, and the persona checks.
The state database uses the built-in `node:sqlite` module. Node 22 prints an experimental warning once at start.
Audio tests also cover upload bounds, speech chain fallback, profile isolation, three response formats, and request deadlines.
