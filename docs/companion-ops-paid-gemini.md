# Companion Ops and paid Gemini: Core contracts

Branch: `integration/r7-ops-paid-gemini`. Base: `integration/r6-media-visual-r7` `4186122b3`.
This document describes what the Companion Core adds for Companion Ops and for the paid Gemini API.
Companion Ops is a separate private repository (`Aurora-source/companion-ops`, branch `integration/companion-ops-live`).

## Owners

| Concern | Owner | Ops role |
| --- | --- | --- |
| Model selection, thinking effort, fallback | Core Gateway (`src/paid/paid-gemini.ts`) | Requests a selection with the ops token |
| Paid usage ledger and spending controls | Core (`companion-ops.sqlite`) | Reads usage, sets optional warnings and limits |
| Director controls | Core Director host | Sets controls. Core stores and restores them |
| Memory, perception, Watch | R4, R5, R6 | Reads status and forwards explicit user actions |
| Processes | Companion Ops supervisor | Starts, stops, and restarts Core with a fixed command |

## Model and effort selection

- The catalog in `src/paid/gemini-catalog.ts` lists the exact ids `gemini-3.1-flash-lite`, `gemini-3.5-flash-lite`,
  `gemini-3.5-flash`, `gemini-3.6-flash`, `gemini-3.7-flash`, and `gemini-3.8-flash`, with Google's documented levels.
  3.7 and 3.8 Flash support `low`, `medium`, and `high`. The others also support `minimal`. No Gemini 3 model has a true off.
- The selection leads the alias `paidGemini.alias` (default `companion-chat`) on provider `paidGemini.provider` (default:
  the only cloud provider with `compat: gemini`). The model appears in routing as `selected:<model id>`.
- The configured chain after it stays the authorized fallback. A configured entry of the same model is not tried again.
- Without a stored choice, the provisional default is `gemini-3.8-flash` with `low`. The `serve` log line names it.
- The selected candidate gets `reasoning_effort`. A client `reasoning_effort` that a catalog model does not support skips
  that model with `THINKING_UNSUPPORTED`. A numeric thinking budget next to the selected effort skips with
  `THINKING_CONFLICT`. The Gateway never converts a level.
- Gemini streaming requests get `stream_options.include_usage`. AIRI's xsAI client ignores usage-only chunks.
- Tool-call index repair, thought signatures, tool continuation, cancellation, and context budgeting are unchanged.
- The `local` profile refuses a selection. `cloud`, `cloud-mura-voice`, and `hybrid` keep their chain rules.

## Paid usage ledger

`companion-ops.sqlite` sits next to `companion-core.sqlite`, so the state database keeps schema version 1 and older
builds that share `%LOCALAPPDATA%\AIRI-Companion` still start. One row per request to a Gemini provider:

| Status | Meaning |
| --- | --- |
| `settled` | Reported usage. Thinking is the `total - prompt - completion` residual, or `reasoning_tokens` when the residual is 0. Output includes thinking once. |
| `unknown` | The request was sent and no usable usage came back (timeout, cancel, broken stream, missing usage). The row keeps a conservative estimate from the Gateway's token estimate. |
| `failed` | Google answered with an HTTP error. No cost. |

Costs are nanodollars from the catalog's dated standard prices. 3.6 to 3.8 Flash double on 2027-01-01. The ledger holds
model ids, efforts, token counts, timings, and error categories. It never holds message text, keys, or provider bodies.
Days and months use `paidGemini.timeZone` (default `America/Los_Angeles`, the Google billing day). Rows older than
`paidGemini.retentionDays` (default 400) are pruned. The halted research ledgers of the benchmark branches are never read.

Estimates are not invoices. Credits, promotions, and taxes are not applied.

## Spending controls

Daily and monthly warnings and limits in USD are `null` by default. A warning changes only what Ops shows. A limit
skips every priced Gemini model (`SPENDING_LIMIT`) until the window ends. The alias then uses its non-Gemini fallback,
or answers 429 `spending_limit_reached`. Unknown rows count at their estimate. Google billing settings are never touched.

## Director persistence

`POST /ops/director/configure` stores the merged user controls under `director-controls`. `CompanionRuntime.attach`
restores them with user authority, so quiet mode, frequency, quiet periods, and a proactive opt-in survive a restart.
Without a stored record proactive speech stays off. Configuration, model output, pages, and subtitles never write it.

A Director binds at the first AIRI turn. Until then, `GET /ops/director/status` has `pendingConfiguration`: the
Director defaults, then the configuration file, then the user controls. It is the configuration that the next Director
starts with, so Ops shows the controls before any turn. A configure request before the first turn applies on binding.

## Ops routes (ops token only)

| Route | Body | Result |
| --- | --- | --- |
| `GET /ops/models` | | Target alias and provider, selection, fallback, catalog with prices and discovery, recommendations |
| `POST /ops/models/select` | `{ model, effort }` | 200, or 400 `unknown_model` / `unsupported_effort` (with `supported`), or 409 |
| `POST /ops/models/discover` | `{}` | Lists the provider's models with the key. No inference and no cost |
| `GET /ops/usage` | | Today, month, by model and effort, latency, errors, recent rows, controls, alerts |
| `POST /ops/usage/controls` | any of `dailyWarningUsd`, `monthlyWarningUsd`, `dailyLimitUsd`, `monthlyLimitUsd` | USD 0 to 100000, or `null` |
| `POST /ops/cloud` | `{ suspended }` | Skips every cloud model, chat, vision, and speech recognition, until resumed. Survives restarts |
| `POST /ops/director/preview` | `{ behavior }`, `{ activity }`, or `{ neutral: true }` | A 4 s Vivid preview through the Director's visual lane |
| `GET /ops/memory/characters` | | AIRI character ids that own memory, with counts, and the active one |
| `POST /ops/shutdown` | `{}` | 202, then the same orderly stop as Ctrl+C |

`GET /ops/status` now lists the effective chain (the selection first) and `cloudSuspended`. Route records carry the
effort. `GET /ops/director/status` adds `conversation.firstSpeech`: milliseconds from the first Gateway request of a
round to the stage's first speech report (p50, p95 after 20 samples, recent values).

## Validation

- Core tests: `test/paid-usage.test.ts`, `test/paid-gemini-gateway.test.ts`, `test/conversation-ledger.test.ts`, and new
  cases in `test/companion-director-gateway.test.ts` and `test/security.test.ts`.
- Live harness: `eval/ops/ops-stack.mts` prepares a disposable Core home with DPAPI test secrets, the AIRI server channel,
  and a fake Gemini-compatible provider that records the model and effort of each request. Companion Ops then launches
  the real `companion-core serve` against it with `COMPANION_CORE_HOME`.
- Live result (2026-10-09): the Companion Ops Edge check passed 10 of 10 checks against this Core. A confirmed
  `gemini-3.7-flash` with `medium` reached the provider exactly, with `include_usage`. Usage showed 400 thinking tokens.
  Selection, spending limit, and Director controls survived a Core restart. Chat returned 503 while cloud was suspended.
- Stage result: `eval/director/live-stage.mts` checks a, e, g, i, and j passed in stage-web against this Core. AIRI
  streamed the selected model's answer with the usage-only chunk, spoke it with ACT, and Core measured first speech.
- Full Core suite: 960 passed, 1 skipped. `persona-runner` rate-limit timing fails on Node 26, and
  `companion-capture` "drops the late reply" fails only under full-suite load. Both fail the same way on the base.
