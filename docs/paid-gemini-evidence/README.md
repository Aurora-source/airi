# Paid Gemini campaign evidence

This bundle contains synthetic benchmark responses, token accounting, timings, and review materials.
The campaign contains 473 paid requests with USD 0.340722225 estimated metered usage.
No private memories, production profiles, media, credentials, avatar assets, or real subtitles are included.

Start with the [report](../paid-gemini-benchmark-report.md) and [campaign summary](campaign-summary.json).
The [manifest](evidence-manifest.json) records source identity, checksums, redactions, and original artifact hashes.
The [validation record](validation.json) distinguishes passing checks from the inherited Core retry assertion.

| Artifact | Purpose |
| --- | --- |
| `discovery.json` | Metadata-only model listing and user-confirmed project binding |
| `prices.json` | Official standard token pricing and future Flash changes |
| `preflight.json`, `preflight-*.json` | Simulated safeguards and source fingerprints at each validation point |
| `ledger.json` | All durable request reservations and settled charges |
| `samples.ndjson` | Raw synthetic responses, reported usage, normalized usage, timings, and request hashes |
| `results.json` | Empirical statistics, context results, and mechanical compatibility findings |
| `monthly-costs.json` | Explicit current and future monthly workload scenarios |
| `voice-text-replay.json` | Offline upstream text-chunker replay, without physical audio measurements |
| `fixture-timings.json` | Local cancellation, failover, and retry measurements, with no paid API calls |
| `human-review.md` | Blinded six-sequence, three-turn dialogue worksheet |
| `human-review-key.json` | Variant mapping. Open it only after scoring |
| `completed-*.json` | Paid-phase completion receipts |
| `validation-excerpts.txt` | Concise retained test and lint results |

Provider thought-signature values are redacted in committed copies.
Their presence and the associated tool behavior remain recorded. Original synthetic artifacts stay in the isolated D: directory.
Markdown and excerpt whitespace is normalized. Raw response text remains intact in `samples.ndjson`.
The retained values cannot continue live tool turns. They are research evidence.

Unknown usage is never interpreted as a zero charge. This completed campaign has no unknown or unresolved usage.
The guard's limit rejection was tested with simulated costs. The live campaign did not reach the spending ceiling.
Small samples do not establish reliable tail latency or a peak-hour service guarantee.
Voice replay does not establish microphone-to-speaker latency.
Human scores, exact project quotas, physical voice acceptance, and final billing reconciliation remain manual work.
