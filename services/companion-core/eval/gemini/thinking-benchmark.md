# Thinking benchmark v2

This campaign compares synthetic Mura dialogue through the existing R2B Gateway.
It changes no production configuration, credentials, memory, or character card.
The campaign has a $5 total estimated ceiling. V1's $0.340722225 remains separate.

## Financial contract

Each request reserves the model's full advertised input window and its explicit combined output cap.
Thinking tokens are billable output. Cached input uses its applicable price.
The campaign admits one request at a time. Provider quotas remain active.
An unknown or aborted request retains its reservation and stops dispatch.
Existing settlements and reservations survive restarts and explicit budget increases.
An increase cannot clear a halted ledger. The hard maximum is $5.
At $2 of settled spending, the research runner stops for evidence review.

Native countTokens does not establish a strict upper bound for this OpenAI-compatible harness.
Its wire representation differs. Google's example reports more generation input tokens than counted tokens.
Gateway injection, recaps, tools, schemas, and thought signatures also affect input.
An average characters-per-token estimate or arbitrary byte multiplier cannot justify lowering reservations.
See [Google's token reference](https://ai.google.dev/api/tokens).

## Safe reproduction

Use the isolated worktree and Node 26.7.0. Do not repeat completed paid phases.
For a new campaign, obtain spending authorization and use one directory throughout that campaign.
If a ledger has unresolved entries, inspect them. Do not delete the ledger or phase markers.

```powershell
Set-Location D:\AI\airi-gemini-thinking
$env:PATH = 'D:\AI\.integration-tmp\node-v26.7.0-win-x64;' + $env:PATH
pnpm install --frozen-lockfile --ignore-scripts
pnpm -r --filter @proj-airi/server-sdk... --filter @proj-airi/server-runtime... --filter @proj-airi/pipelines-audio... build
```

Check each command's exit status before the next command.
Keep the credential in the process environment. Never paste it into a command or report.
Use the existing Windows User credential. Do not modify the protected credential store.

```powershell
$campaignDirectory = 'D:\AI\authorized-new-thinking-campaign'
$env:GEMINI_API_KEY = [Environment]::GetEnvironmentVariable('GEMINI_API_KEY', 'User')
pnpm -F @proj-airi/companion-core exec tsx eval/gemini/thinking-cli.ts discover $campaignDirectory
pnpm -F @proj-airi/companion-core exec tsx eval/gemini/thinking-cli.ts preflight $campaignDirectory
```

Before inference, verify current official prices and refresh the source-bound receipt.
The receipt expires after 24 hours or when source, discovery, or prices change.
The price validity date also stops dispatch. Update it only after official verification.

Each paid phase requires explicit authorization and `--paid`.
The runner rejects an already started phase, including an interrupted phase.
Use a completed campaign only for offline inspection.

```powershell
pnpm -F @proj-airi/companion-core exec tsx eval/gemini/thinking-cli.ts pilot $campaignDirectory --paid
pnpm -F @proj-airi/companion-core exec tsx eval/gemini/thinking-cli.ts latency $campaignDirectory --paid
pnpm -F @proj-airi/companion-core exec tsx eval/gemini/thinking-cli.ts quality $campaignDirectory --paid
pnpm -F @proj-airi/companion-core exec tsx eval/gemini/thinking-cli.ts quality-repeat $campaignDirectory --paid
pnpm -F @proj-airi/companion-core exec tsx eval/gemini/thinking-cli.ts quality-extension $campaignDirectory --paid
pnpm -F @proj-airi/companion-core exec tsx eval/gemini/thinking-cli.ts secondary $campaignDirectory --paid
```

After reviewing the first comparisons, select finalist work. Do not run every phase automatically.
Finalist commands are `finalists`, `context`, and `direct`.
The `latency-topup` phase supplements this campaign's original matrix after explicit in-process warmup.
Remove the process credential when paid work ends.

```powershell
Remove-Item Env:GEMINI_API_KEY
pnpm -F @proj-airi/companion-core exec tsx eval/gemini/thinking-cli.ts report $campaignDirectory
```

The report command makes no provider requests. It replays recorded text through the existing TTS chunker.
Its chunk readiness is not measured microphone, STT, TTS, buffering, playback, or first-audio latency.

## Review artifacts

`samples.ndjson` and `ledger.json` preserve per-request measurements and accounting.
`results.json`, `comparison.csv`, and `monthly-costs.json` contain derived measurements.
`human-review.md` contains blinded dialogues. Keep `human-review-key.json` closed until scoring ends.
The worksheet scores naturalness, personality, nuance, humor, consistency, conciseness, flow, and overall preference.
Mechanical ACT checks do not determine personality preference.
Minimal thinking does not guarantee zero thinking, even when some requests report zero.

Export thought signatures as hashes and presence flags before publication. Preserve originals outside committed evidence.
Do not commit credentials, private conversations, protected stores, or production secrets.
