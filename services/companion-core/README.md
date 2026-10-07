# @proj-airi/companion-core

Companion Core is a local service that sits between AIRI and cloud model providers.
This first slice (R2A) is only the **Companion Gateway**. It is a transparent, authenticated proxy for OpenAI-compatible chat completions.

## What it does

- Listens on `127.0.0.1` only. The default port is `11980`.
- Accepts `POST /v1/chat/completions` and `GET /v1/models` from AIRI's **OpenAI Compatible** chat provider.
- Maps a stable alias, for example `companion-chat`, to **one** configured provider and model.
- Forwards the request body with every field kept. Only `model` changes.
- Streams the provider response back byte for byte. Server-sent events, tool calls, finish reasons, usage, and provider errors pass through unchanged.
- Aborts the provider request when AIRI cancels.
- Keeps provider API keys out of AIRI. AIRI holds only a local gateway token.

It does **not** route between providers, track quotas, trim prompts, add memory, or watch the screen. Those parts come in later phases.

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
