# Paid Gemini evaluation

This harness measures synthetic companion workloads through Gemini directly and the existing R2B Gateway.
It uses discovered API model IDs, fresh quota state, and an independent durable spending ledger.
It does not read production credentials, memory, probes, profiles, media, or avatar assets.

Use this directory for controlled research. Production routing remains owned by Companion Core configuration.
Do not use this harness as another Gateway or as a production model-selection service.

## Safety contract

- The campaign stops before an estimated $4.50 charge. The ceiling cannot increase on restart.
- Each dispatch reserves the full advertised input capacity and the combined thinking/output limit.
- At most two requests can be in flight. Cached input receives its applicable price.
- Unknown final usage keeps the reservation and halts paid dispatch.
- Conflicting output limits, priority tiers, audio generation, paid server tools, and explicit cache storage are unsupported.
- Failed requests with valid reported usage remain charged. No automatic retries occur.
- A process lock prevents a second ledger owner. Unresolved reservations prevent restart.
- Fresh test receipts bind source, discovery, and prices before paid phases.
- Discovery is metadata-only. Model presence does not prove inference access or a billing tier.
- Each Gateway alias contains one cloud candidate. Failover is tested with deterministic fixtures.

Google's enforced project quotas remain active. The paid benchmark omits the repository fixture's artificial free quotas.
The baseline reproduces that fixture. It does not inspect the user's live production configuration.

## Reproduce a small benchmark

Use Node 26.7.0 and the isolated worktree. Keep all output on D:.
If official prices changed, update `corpus.ts` and the validity date in `preflight.ts` before testing.
Verify prices at [Google pricing](https://ai.google.dev/gemini-api/docs/pricing).
Never copy a secret into a command, report, issue, or chat.

```powershell
Set-Location D:\AI\airi-gemini-bench
$env:PATH = 'D:\AI\.integration-tmp\node-v26.7.0-win-x64;' + $env:PATH
$env:TEMP = 'D:\AI\.integration-tmp\gemini-bench-temp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
pnpm install --frozen-lockfile --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
pnpm -r --filter @proj-airi/server-sdk... --filter @proj-airi/pipelines-audio... build
if ($LASTEXITCODE -ne 0) { throw 'Internal package build failed' }
$env:GEMINI_API_KEY = [Environment]::GetEnvironmentVariable('GEMINI_API_KEY', 'User')
pnpm -F @proj-airi/companion-core gemini-bench discover D:\AI\gemini-small-reproduction
if ($LASTEXITCODE -ne 0) { throw 'Discovery failed' }
pnpm -F @proj-airi/companion-core gemini-bench preflight D:\AI\gemini-small-reproduction
if ($LASTEXITCODE -ne 0) { throw 'Safety preflight failed' }
pnpm -F @proj-airi/companion-core gemini-bench pilot D:\AI\gemini-small-reproduction --paid --small
if ($LASTEXITCODE -ne 0) { throw 'Pilot stopped. Inspect the ledger' }
pnpm -F @proj-airi/companion-core gemini-bench latency D:\AI\gemini-small-reproduction --paid --small
if ($LASTEXITCODE -ne 0) { throw 'Latency phase stopped. Inspect the ledger' }
pnpm -F @proj-airi/companion-core gemini-bench report D:\AI\gemini-small-reproduction
Remove-Item Env:GEMINI_API_KEY
```

Run each command only after the preceding command succeeds. A failed campaign requires ledger inspection.
Never delete unresolved entries or create another ledger to conceal ambiguous charges.
Small latency runs have three samples per model/path. They provide smoke-test evidence, without a p95 claim.

Full paid phases are `pilot`, `latency`, `optimization`, `quality`, `context`, `capabilities`, `concurrency`, `voice-text`, and `envelope`.
All paid phases require `--paid`. Completed phases reject repetition.
The same output directory shares one campaign budget across phases and warmups.

The `fixtures` command measures loopback cancellation, retry, and failover. It requires no key and makes no paid calls.
The `report` command reads captured samples and replays upstream text chunking. It makes no paid calls.
For the completed campaign, use only these offline commands. Do not repeat its paid phases.

```powershell
pnpm -F @proj-airi/companion-core gemini-bench fixtures D:\AI\gemini-offline-validation
pnpm -F @proj-airi/companion-core gemini-bench report D:\AI\gemini-benchmark-data
```

## Artifacts

| File | Content |
| --- | --- |
| `discovery.json` | Exact API IDs, capacities, timestamp, and user-confirmed project binding |
| `preflight.json` | Zero-inference safeguard receipt |
| `ledger.json` | Durable reservations and settled usage in nanodollars |
| `samples.ndjson` | Timings, token totals, synthetic replies, request hashes, and capabilities |
| `results.json` | Empirical quantiles and mechanical persona checks |
| `prices.json` | Official standard token prices and the announced future Flash multiplier |
| `monthly-costs.json` | Explicit workload scenarios, measured response tokens, STT, and uncertainty ranges |
| `voice-text-replay.json` | Recorded stream arrivals replayed through the upstream text chunker |
| `fixture-timings.json` | Zero-paid-call cancellation, HTTP 429 retry, and HTTP 503 failover timings |
| `human-review.md` | Blinded multi-turn dialogue worksheet |
| `human-review-key.json` | Model and thinking settings, revealed after scoring |

Meaningful text excludes ACT and other stage markers. Unterminated markers remain withheld.
First sentence uses a punctuation boundary. Voice replay uses the existing upstream chunker after strict ACT removal.
Neither measure establishes TTS startup, audible playback, ACT delay execution, or microphone-to-speaker latency.
Provider computation and network time remain combined without provider telemetry.
Twenty samples permit an empirical p95, with substantial uncertainty. Cold requests remain separate.

Gemini can report thinking outside `completion_tokens`. The ledger normalizes it from reported totals and checks explicit details.
The raw terminal usage remains attached to each new sample for audit.

## Validation

```powershell
pnpm -F @proj-airi/companion-core exec vitest run test/gemini-benchmark.test.ts
pnpm -F @proj-airi/companion-core typecheck
pnpm -F @proj-airi/companion-core exec vitest run
pnpm typecheck
pnpm lint
```

The safeguard suite makes no paid API calls. Synthetic HTTP servers exercise the real Gateway locally.
The final report lists broader regressions, missing physical voice validation, pricing assumptions, and integration instructions.
