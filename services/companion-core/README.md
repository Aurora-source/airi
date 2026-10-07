# @proj-airi/companion-core

Companion Core is a local service that sits between AIRI and cloud model providers.
The **Companion Gateway** is its first part. It gives AIRI one stable OpenAI-compatible endpoint, and it chooses the model behind it.

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

It does **not** hold memory, watch the screen, run a Director, or start local services. Those parts come in later phases.

## Configuration

The file is `%LOCALAPPDATA%\AIRI-Companion\companion-core.json`. Provider and model names are data, so a new model is an edit and not a code change.

| Section | Content |
| --- | --- |
| `profile` | `local`, `cloud`, `cloud-mura-voice` (default), or `hybrid`. It decides which models a chain can hold. |
| `providers` | `baseURL`, `keyRef`, optional `compat: "gemini"`, and `locality` (`cloud` or `local`). |
| `models` | One entry per model: `provider`, the provider's `model` name, `capabilities`, and published `limits`. |
| `aliases` | A `role`, an ordered `chain` of model ids, and the prompt targets. |
| `routing` | Sticky time, first-byte timeout, cool-downs, and the token safety margin. |
| `store` | The SQLite file. It defaults to `companion-core.sqlite` next to the configuration. |

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
- A judge from **another provider** scores each answer. A model never judges its own family.
- `report` writes `blind-ranking.html` and a sealed `key.json`. Rank the answers in the page without the key, then score the export.

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
