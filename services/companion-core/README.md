# @proj-airi/companion-core

Companion Core is a local service that sits between AIRI and cloud model providers.
The **Companion Gateway** forwards authenticated OpenAI-compatible chat completions and audio transcriptions.

## What it does

- Listens on `127.0.0.1` only. The default port is `11980`.
- Accepts `POST /v1/chat/completions` and `GET /v1/models` from AIRI's **OpenAI Compatible** chat provider.
- Maps a stable alias, for example `companion-chat`, to **one** configured provider and model.
- Forwards the request body with every field kept. Only `model` changes.
- Streams the provider response back byte for byte. Server-sent events, tool calls, finish reasons, usage, and provider errors pass through unchanged.
- Aborts the provider request when AIRI cancels.
- Keeps provider API keys out of AIRI. AIRI holds only a local gateway token.

Chat aliases retain one configured provider and model. Audio uses its separate profile configuration.

## Provider compatibility

A provider entry can set `"compat": "gemini"`. Only that provider's successful event streams change:

- The Gemini OpenAI-compatible endpoint omits `index` on streamed tool-call fragments. OpenAI clients, including AIRI's xsAI client, drop such tool calls.
- The adapter adds `index` from a stable per-choice `id` to index map. A fragment without an `id` continues the call that is still streaming.
- Every other byte stays the same, including `finish_reason`, text, and `extra_content.google.thought_signature`. Error bodies and non-streaming responses are not touched.

Without `compat`, the gateway is a byte-for-byte passthrough.

## Security

| Control | Behavior |
| --- | --- |
| Binding | `127.0.0.1` only. The configuration rejects any other host. |
| Tokens | Two separate bearer tokens. The inference token works only on `/v1/*`. The ops token is reserved for future `/ops/*` routes. |
| Storage | Tokens and provider keys are Windows DPAPI blobs in `%LOCALAPPDATA%\AIRI-Companion\secrets\`. |
| Host | The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`. This blocks DNS-rebinding pages. |
| Origin | A request with an `Origin` header must match `allowedOrigins` exactly, even with a valid token. |
| Logs | One metadata line per request. Headers, bodies, prompts, images, and credentials are never logged. Known secrets and key-shaped strings are redacted. |
| No token | Only `GET /livez`. It returns `{"ok":true}` and nothing else. |

## How to use

1. Create the starter configuration and the gateway tokens:

   ```powershell
   pnpm -F @proj-airi/companion-core cli init
   ```

2. Store the provider API key. Set an environment variable first, then import it. The command never prints the value.

   ```powershell
   pnpm -F @proj-airi/companion-core cli secret-import provider-gemini --from-env GEMINI_API_KEY
   ```

3. Edit `%LOCALAPPDATA%\AIRI-Companion\companion-core.json`:

   ```json
   {
     "port": 11980,
     "allowedOrigins": ["file://"],
     "providers": {
       "gemini": { "baseURL": "https://generativelanguage.googleapis.com/v1beta/openai/", "keyRef": "provider-gemini" }
     },
     "aliases": {
       "companion-chat": { "provider": "gemini", "model": "<model id that passed the probe>" }
     }
   }
   ```

   The model name is configuration. Choose it from a live probe, not from documentation.

4. Start the gateway:

   ```powershell
   pnpm -F @proj-airi/companion-core start
   ```

5. In AIRI, open **Settings > Providers > Chat > OpenAI Compatible**:
   - Base URL: `http://127.0.0.1:11980/v1/`
   - API key: the output of `pnpm -F @proj-airi/companion-core cli token`
   - Model: `companion-chat`

## Audio transcription

Create `companion-audio.json` beside `companion-core.json`. `COMPANION_CORE_HOME` also applies to this file.
An absent audio file disables transcription and omits `companion-stt` from `/v1/models`.

For Groq transcription, use:

```json
{
  "profile": "CLOUD"
}
```

The CLI loads the `provider-groq` DPAPI secret first. Then it checks inherited `GROQ_API_KEY` and the Windows user environment.
The key stays inside Companion Core. To store a key from the environment, run:

```powershell
rtk proxy pnpm -F @proj-airi/companion-core cli secret-import provider-groq --from-env GROQ_API_KEY
```

| Profile | Audio target |
| --- | --- |
| `CLOUD`, `cloud-mura` | Groq only. A local target is rejected. |
| `LOCAL` | One explicit loopback target. Companion Core does not start its inference server. |
| `HYBRID` | Groq first. A local fallback requires an explicit `local` entry. |

For an explicit local target or HYBRID fallback, use:

```json
{
  "profile": "HYBRID",
  "local": {
    "baseURL": "http://127.0.0.1:11437/v1/",
    "model": "your-local-stt-model"
  }
}
```

Set `model` to the model your local server accepts. For local-only transcription, change `profile` to `LOCAL`.
Local targets accept only literal `127.0.0.1` or `::1` addresses. The Groq endpoint is fixed, and redirects fail.

Groq uses `whisper-large-v3-turbo`, then `whisper-large-v3` when the first model is unavailable.
Cloud rate limits return their status and `Retry-After`. An explicit HYBRID local target can handle cloud rate limits or availability failures.
The client model alias cannot change the profile or the provider model.

In AIRI's OpenAI-compatible transcription provider, set the gateway base URL, inference token, and model `companion-stt`.
`POST /v1/audio/transcriptions` accepts multipart `file` and `model` fields. URL input is rejected.
Optional fields are `language` (ISO 639-1), `prompt`, `temperature` (0–1), and `response_format` (`json`, `text`, or `verbose_json`).
Each request keeps audio in memory. Filenames change to `audio.<format>`, while the audio bytes and format stay intact.

The defaults are `timeoutMs: 15000`, `maxRequestBytes: 26214400`, and `maxResponseBytes: 1048576`.
The upload limit includes multipart headers. One deadline covers upload, fallback attempts, and the complete provider response.
Client cancellation stops upload or the provider request. Logs contain metadata, with no audio, transcript, prompt, or key.

## When to use it

- You want AIRI to use a cloud model without storing the provider key in AIRI.
- You want one local place that later phases can extend with routing, memory, and awareness.

## When not to use it

- You only use a local model. Point AIRI at Ollama directly.
- You need a provider that does not speak the OpenAI chat-completions protocol.
- You want to reach the gateway from another machine. It is loopback-only by design.

## Tests

```powershell
pnpm -F @proj-airi/companion-core exec vitest run
pnpm -F @proj-airi/companion-core typecheck
```

The tests start a fake provider and cover streaming, chunk boundaries, tool calls, tool results, images, provider errors, cancellation, authentication, Host and Origin checks, log redaction, loopback binding, and a DPAPI round trip on Windows.
Audio tests also cover upload bounds, model fallback, profile isolation, three response formats, and request deadlines.
