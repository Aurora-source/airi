# Findings

## Final measured campaign

- All 473 paid calls settled. Total estimated metered spending is USD 0.340722225.
- No live quota error, missing usage, incomplete stream, or retry occurred. Threshold rejection was validated with simulated costs.
- Warm paid Gateway first-text p50/p95: Lite 3.1 minimal 959/1,274 ms. Flash 3.8 low 2,305/2,718 ms. Each has 20 samples.
- Provider selection and request preparation took milliseconds. Provider/network response time dominates these short requests.
- Lite 3.5 malformed ACT blocks withheld meaningful text in two of 20 latency samples. Its text p95 is not reported.
- A reminder restored meaningful text in 20 short Lite 3.5 trials. Multi-turn ACT failures persisted. No latency gain was measured.
- Native automatic tools, valid continuations, structured JSON, and synthetic red/blue vision each passed eight checks.
- The initial stage-CALL versus native-tool mismatch remains visible and charged. No forced tool-selection result replaces an automatic denominator.
- The existing five-function fixture produces a more realistic 3,473-token envelope. Five samples per model/path cannot establish tail latency.
- Synthetic long-context anchors survived the paid context budget and were removed by the fixture baseline.
- Physical STT, Mura TTS, audio playback, lip sync, interruption, and barge-in remain manual acceptance work.
- Flash 3.8 medium gives stronger reviewed character dialogue at approximately 5.4 seconds mean completion time.
- Human worksheet scores remain pending. The investigator opened the mapping only after recording blinded observations.
- Actual paid-project RPM, TPM, and RPD remain unverified. The user-confirmed project binding and INR 9.09 observation are retained.
- Monthly ranges are workload scenarios, not confidence intervals. Promotional credit eligibility remains unconfirmed.
- Exact-base reproduction isolates the existing retry-timing test failure from this harness.

## Paid pilot and source audit

- Five successful pilot calls cost an estimated $0.002068. Final reported usage settled every reservation.
- Gemini 3.1 and 3.5 Flash-Lite used minimal thinking. Gemini 3.7 and 3.8 Flash used low thinking.
- Google confirms compatibility totals include thinking, even when completion tokens exclude it. The meter accounts for the residual.
- The latency campaign compares direct, fixture baseline, and paid Gateway with counterbalanced model/path order.
- Some 3.5 Flash-Lite replies have malformed ACT closing markers. A valid HTTP response does not guarantee spoken text.
- Actual free quota settings exist in test/support/catalog.ts and the R3 fixture. They are not hard-coded sleeps.
- Prompt defaults are explicit quality policies. No source evidence labels them free-tier workarounds.
- R5 debounce, privacy gates, and duplicate suppression remain. R6 requires silence and a three-minute reaction cooldown.
- R7 contracts expose deterministic decisions, optional reasoning, and bounded output admission. R7 remains unmerged and disabled.
- The architecture's historical $0-only assumption is superseded for this authorized paid benchmark.
- During the quality campaign, the user reported AI Studio spend of INR 9.09 for the identified project.
- The local ledger then held about USD 0.1605. Billing currency, reporting window, and update lag prevent an exact reconciliation.
- No promotional credit is assumed. No billing settings changed.
- Live low-thinking Flash-Lite responses reported a positive total-token residual. The meter charged thinking correctly.

## Blinded investigator observations before key reveal

- Variant F gave the most natural emotional follow-up in the reviewed excerpts. Its ceiling-staring joke followed the user's gentle-humor preference.
- Variant B also gave warm, concise dialogue. Its dramatic resilience joke needs human review against the no-big-compliments preference.
- Variant C kept a coherent voice, with more formal phrasing.
- Variant D directly described its ability to perform gentle humor. That phrasing sounded more like an assistant.
- Variants A and H leaked malformed ACT syntax in emotional follow-ups.
- Variant E repeated delay markers. Variant G had an empty emotional follow-up.
- These are qualitative investigator observations. They are not human rankings or statistically validated charm scores.
- The observations above were recorded before the mapping was opened. They do not replace human scoring.

## Historical preflight observations

- Exact base and origin `Aurora-source/airi` verified.
- Requested worktree and branch were created at the exact base with a clean working tree.
- Source worktree has an unrelated VS Code package change. It remains untouched.
- Process and user Gemini environment variables exist. Values were neither printed nor captured.
- Current shell Node is 22.22.2. Task requires the existing Node 26.7.0 runtime.
- Official pricing, models, and rate-limit pages opened on 2026-10-08. Current pricing lists Gemini 3.8 and 3.7 Flash.
- At initial preflight, no paid inference had occurred. No credential store was exported throughout the campaign.
- User confirmed project ID `gen-lang-client-0341576079`, number `825264326503`.
- Node 26.7.0 exists at `D:/AI/.integration-tmp/node-v26.7.0-win-x64/node.exe`.
- Isolated filtered dependencies installed offline with frozen lockfile and scripts disabled. No dependency changes.
- Existing GatewayRuntime accepts isolated config, provider keys in memory, and independent SQLite state.
- Existing usage sniffer reports prompt/completion totals, without monetary, cache, or reasoning-category validation.
- Source Gemini compatibility preserves missing tool-call indices and thought signatures. Retain it in both configurations.
- Spend guard red run: 16 failed, 6 passed. Green run: 22 passed. No network calls.
- Addendum requires actual free-tier restriction audit and baseline/paid comparison. No speculative removal of safety policies.

## Official sources

- https://ai.google.dev/gemini-api/docs/pricing
- https://ai.google.dev/gemini-api/docs/models
- https://ai.google.dev/gemini-api/docs/rate-limits
