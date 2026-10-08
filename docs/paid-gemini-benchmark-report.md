# Paid Gemini benchmarks for Mura

Research branch: `codex/paid-gemini-benchmarks`.
Exact base: `4eabf3daa9d8c8558964ebdb37b242cbf31533f5`.
Worktree: `D:/AI/airi-gemini-bench`.

The campaign completed **473 paid requests for an estimated $0.340722225 USD**.
All reservations settled. No usage was ambiguous. No paid retry, quota exhaustion, or automatic reload occurred.
The guard rejected unsafe spending in simulation before paid inference began.

**Recommended default: `gemini-3.8-flash`, low thinking.**
**Fastest and cheapest tested: `gemini-3.1-flash-lite`, minimal thinking.**
**Best observed emotional dialogue: `gemini-3.8-flash`, medium thinking.**
These quality recommendations are provisional. Human scoring and the actual Mura voice pipeline remain integration acceptance checks.

Gateway overhead measured milliseconds. Provider and network time dominated the short-turn results.
There is no evidence that a production routing rewrite improves these results.

## Results comparison

Times below measure the first meaningful text through the paid Gateway. They do not measure audible speech.

| Model | Thinking | Requests / meaningful replies | Text p50 | Text p95 | Total p50 | Short-turn mean USD / 1,000 requests |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `gemini-3.1-flash-lite` | minimal | 20 / 20 | 0.959 s | 1.274 s | 1.009 s | $0.224 |
| `gemini-3.5-flash-lite` | minimal | 20 / 18 | 1.247 s | Not reported | 1.292 s | $0.296 |
| `gemini-3.7-flash` | low | 20 / 20 | 2.195 s | 2.664 s | 2.321 s | $0.628 |
| `gemini-3.8-flash` | low | 20 / 20 | 2.305 s | 2.718 s | 2.388 s | $0.628 |

The two missing meaningful replies from 3.5 Lite contained malformed control text. Their usage and costs remain included.
The meaningful-text p95 requires twenty meaningful samples. An empirical p95 at twenty samples still has substantial uncertainty.
These short prompts averaged about 585 input tokens. They underestimate the cost of accumulated history and full tool schemas.

Machine results contain p50, p90, eligible p95, minimum, maximum, mean, standard deviation, and each metric's sample count.
See [results.json](paid-gemini-evidence/results.json) and [samples.ndjson](paid-gemini-evidence/samples.ndjson).

## A. Available models and official pricing

Model discovery used the current Windows User environment credential through Google's native model-list endpoint.
It returned 45 generation models without inference. The retained metadata contains exact IDs and advertised capacities.

The user confirmed project `gen-lang-client-0341576079`, number `825264326503`, and Paid Tier 1.
The model-list endpoint does not independently establish the key's project or billing tier.
An independent project-binding check requires authorized project telemetry. No credential was printed or exported.

All nine stable candidates below appeared in metadata. The four marked tested completed paid inference and capability checks.
Text and image-input prices use standard service. Values are USD per million tokens.

| Exact API ID | Status | Input | Cached input | Generated output, including thinking | Evaluation |
| --- | --- | ---: | ---: | ---: | --- |
| `gemini-2.5-flash-lite` | Stable | $0.10 | $0.01 | $0.40 | Listed, not tested |
| `gemini-2.5-flash` | Stable | $0.30 | $0.03 | $2.50 | Listed, not tested |
| `gemini-2.5-pro` | Stable | $1.25 / $2.50 | $0.125 / $0.25 | $10 / $15 | Listed, not tested |
| `gemini-3.1-flash-lite` | Stable | $0.25 | $0.025 | $1.50 | Tested |
| `gemini-3.5-flash-lite` | Stable | $0.30 | $0.03 | $2.50 | Tested |
| `gemini-3.5-flash` | Stable | $1.50 | $0.15 | $9.00 | Listed, not tested |
| `gemini-3.6-flash` | Stable | $0.75 | $0.075 | $3.75 | Listed, not tested |
| `gemini-3.7-flash` | Stable | $0.75 | $0.075 | $3.75 | Tested |
| `gemini-3.8-flash` | Stable | $0.75 | $0.075 | $3.75 | Tested |

The two 2.5 Pro rates apply at input lengths up to 200,000 tokens and above 200,000 tokens, respectively.
The tier uses the entire prompt, including cached tokens.
For 3.6, 3.7, and 3.8 Flash, the listed rates last through December 31, 2026.
Google lists twice those input, cached-input, and output rates from January 1, 2027.
Sources: [official pricing](https://ai.google.dev/gemini-api/docs/pricing), [3.6 model guide](https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash).

The selected models advertise **1,048,576 input tokens and 65,536 output tokens**.
Metadata supports generation, token counting, caching, and batch generation for these models.
Live requests established streaming, native functions, structured JSON, image input, and terminal usage for all four candidates.
The image test is a simple color fixture. It does not establish comparative OCR or video understanding quality.

3.1 and 3.5 Lite accept minimal thinking. 3.7 and 3.8 Flash support low, medium, and high, with medium as default.
Minimal thinking is unsupported on 3.7 and 3.8. Thinking is billed as output.
Sources: [thinking configuration](https://ai.google.dev/gemini-api/docs/thinking), [3.8 model](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash).

No shutdown date was announced for the selected stable models in the checked deprecation schedule.
Older 2.5 availability has additional active-user restrictions. Listing alone is insufficient proof of inference access.
Sources: [model documentation](https://ai.google.dev/gemini-api/docs/models), [deprecations](https://ai.google.dev/gemini-api/docs/deprecations).

Available previews included `gemini-3-flash-preview` and `gemini-3.1-pro-preview` variants.
They were excluded from paid testing. Newer stable Flash models cover this task without preview deployment risk.
`gemini-3.8-pro` was absent from discovery. No nonexistent-model inference probes were issued.

See [discovery.json](paid-gemini-evidence/discovery.json) and [prices.json](paid-gemini-evidence/prices.json).

## B. Paid quotas and the historical restrictions audit

Google enforces project quotas independently of this benchmark.
The exact project's RPM, TPM, and RPD values were unavailable. They require AI Studio's active limits display.
The user supplied a spend figure, without numeric quotas.
Paid status increases available service allowances. It does not guarantee a latency reduction.
Source: [Google rate limits](https://ai.google.dev/gemini-api/docs/rate-limits).

The baseline and optimized paths used the **same paid key and endpoint**.
They compare local configuration policies. They do not compare Google's actual free and paid service tiers.
The baseline reproduces repository fixture limits, with a single candidate for each measured model.
It does not reproduce the user's private production configuration or its entire fallback chain.

| Located setting | Source | Purpose and observed effect | Recommendation |
| --- | --- | --- | --- |
| Gemini 15 RPM, 500 RPD, 250,000 TPM | `services/companion-core/test/support/catalog.ts`, `packages/testing-audio/cases/r3-voice/gateway.r2b.json` | Free-tier-oriented fixture quotas. They are explicit configuration, not Gateway defaults. | Set project-specific paid quotas in production. Omit historical fixture caps in isolated testing. |
| Old preview model at 5 RPM and 20 RPD | R3 voice configuration fixture | Restricted historical availability. The selected stable models avoid this fixture entry. | Refresh model IDs and project limits. Keep the reproducible historical fixture. |
| Lite before Groq in a fixture chain | R2B catalog and R3 voice fixture | A configured model order. The router does not hardcode a Lite preference. | Choose Flash for quality. Retain configurable chains and CLOUD-only inference. |
| 1,000,000 context / 8,192 output in fixtures | Same fixtures | Conservative advertised capacities. Both paths used comparable 2,048 or 4,096 generated-token caps. | Use discovered capacities. Keep bounded conversational output. No benefit from oversized replies was established. |
| Prompt targets 20k / 30k / 50k and 0.85 low-water ratio | `src/config/config.ts`, `src/budget/budgeter.ts` | Explicit quality policy. A free-tier-only origin was not established. Long-history anchors were trimmed at the baseline target. | Retain normal targets. Offer the tested 60k / 80k / 100k policy for selected long-context turns. |
| Output reserve 1,024 and tool-result reserve 800 | `src/config/config.ts` | Reserves room for completion and atomic tool continuation. | Retain. These protect correctness. |
| Token safety factor 1.05 | `src/config/config.ts` | Protects quota checks against estimation error. | Retain. |
| First-byte timeout 30 s | `src/config/config.ts`, `src/gateway/chat-completions.ts` | Bounded provider failure handling. It does not sleep before a successful request. | Retain until real voice deadlines are validated. |
| Failure cooldown 10 s, exponential maximum 300 s | `src/routing/health.ts`, configuration | Protects failing providers. No cooldown occurred during successful paid measurements. | Retain and honor provider Retry-After. Do not classify this as a free-only workaround. |
| Sticky choice, idle reset 360 min | `src/routing/sticky.ts`, configuration | Preserves character continuity. Fresh benchmark state prevented stale selections. | Retain. Use isolated state for future testing. |
| Persona-evaluation retry waits | `eval/persona/client.ts` | 429 waits use Retry-After plus 250 ms. Network/server retries use 3 s. | Keep separate from provider latency. This benchmark performs no automatic paid retry. |
| VAD silence 1,200 ms | R3 voice fixture and voice documentation | Endpoint detection. No free-quota-only purpose was established. | Preserve until microphone testing establishes a better trade-off. |
| TTS chunking and provider-specific full-response buffering | `packages/pipelines-audio/src/processors/tts-chunker.ts`, Stage speech pipeline | Chunk boundaries and provider input requirements. No global Mura speech truncation was found. | Preserve Mura TTS and VoiceController. |
| NOW capture/debounce/deduplication and ambient refresh defaults | R5 perception source and report | Privacy, freshness, and admission. Capturing a frame does not imply an inference request. | Preserve. |
| WATCH cooldown 180 s, silence evidence, interruption and duplicate checks | `src/watch/contracts.ts`, R6 report | Reaction admission and privacy. | Preserve. Paid access does not authorize proactive speech. |
| Gemini missing-index repair and thought signatures | `src/providers/gemini-compat.ts` | Actual API compatibility. Direct streams still omitted tool indices. | Retain unchanged. |

No hidden successful-request sleep, forced Lite choice, disabled tool capability, or compulsory local fallback was found in the Gateway.
Private production quota/probe state was not inspected or modified.
Each benchmark phase created fresh in-memory routing, quota, health, sticky, and probe state.

## C. Spending safeguards

The isolated ledger is independent of R2B's request/token quota ledger.
It owns the campaign's estimated monetary exposure in integer nanodollars.

Before dispatch, it reserves the advertised input capacity plus the combined generated-token cap.
This avoids treating a tokenizer estimate as a strict financial bound.
The guard rejects an exposure equal to or above $4.50. It also rejects concurrency above two.
The absolute $5 planning limit was never approached.

Terminal reported usage settles a reservation. Cached input receives its own rate.
Thinking is a subset of normalized generated output. It is never charged twice.
Gemini compatibility responses can report thinking in total tokens outside completion tokens.
The parser checks the residual and explicit details before settlement.
Source: [Google staff usage clarification](https://discuss.ai.google.dev/t/gemini-3-6-flash-openai-compatible-token-limits-response-fields-and-auth-keys/183372/2).

Missing, inconsistent, incomplete, unknown, or unpriced usage halts dispatch and retains reserved exposure.
Failures with valid reported usage remain charged. Interrupted requests cannot become zero-cost assumptions.
Exclusive locking, atomic replacement, and fsync protect persisted ownership and accounting.
Restart refuses unresolved reservations. A new process cannot raise the ceiling or erase prior charges.

Each paid phase requires `--paid`, matching source/discovery/price fingerprints, and a fresh simulated-test receipt.
Completed phases reject repetition. No automatic top-up or automatic paid retry exists.
Priority service, conflicting token-limit overrides, paid server tools, audio generation, and explicit cache storage are unsupported.
The selected token caps stayed far below advertised output capacity without restricting ordinary dialogue length.

The final safeguard suite passed **52 tests**, including local fixtures. Preflight itself made zero paid calls.
Tests cover price tiers, cache and thinking totals, unknown usage, exact-ceiling rejection, in-flight exposure, ownership, persistence failure, and cancellation.
They also cover discovery, streaming timing, real Gateway timing, deterministic corpus data, aggregation, and report generation.

## D. Observed expenditure

| Workload | Paid requests | Estimated USD |
| --- | ---: | ---: |
| Pilots | 5 | $0.002068000 |
| Warmups | 12 | $0.005306750 |
| Warmed latency | 192 | $0.084748500 |
| ACT reminder experiment | 20 | $0.006170500 |
| Multi-turn character evaluation | 144 | $0.111977150 |
| Context experiments | 20 | $0.068907725 |
| Tools, structured JSON, and vision | 33 | $0.013519850 |
| Limited concurrency | 12 | $0.005454250 |
| Voice text capture | 15 | $0.005686250 |
| Existing AIRI schema envelope | 20 | $0.036883250 |
| **Total** | **473** | **$0.340722225** |

All 473 requests have final usage and a completed stream. No live HTTP error, 429, or unaccounted request occurred.
HTTP success does not imply valid persona formatting or correct tool selection.
The failed original tool-selection probe remains charged and retained.

Three context responses reported **17,009 cached input tokens** in total.
Cache hits were implicit. The harness created no explicit cache and incurred no cache-storage charge.

The user reported **₹9.09** in AI Studio during the campaign.
This is a separate currency and telemetry snapshot. It is not reconciled with the completed campaign's USD meter.
Billing lag, reporting interval, currency conversion, and taxes require a final manual cross-check.
Promotional credits were not assumed. No billing configuration changed.

## E. Direct-provider latency

The direct path uses the existing Gemini request adaptation and streaming compatibility behavior.
It bypasses AIRI routing and context assembly.

| Model | Meaningful samples | Text p50 | Text p95 | Total p50 |
| --- | ---: | ---: | ---: | ---: |
| 3.1 Lite, minimal | 20 | 0.938 s | 1.502 s | 0.990 s |
| 3.5 Lite, minimal | 18 of 20 | 1.185 s | Not reported | 1.273 s |
| 3.7 Flash, low | 20 | 2.094 s | 2.450 s | 2.263 s |
| 3.8 Flash, low | 20 | 2.257 s | 3.593 s | 2.274 s |

Cold pilots and twelve path/model warmups remain separate from warmed latency summaries.
Requests were serial and counterbalanced across model and path order.
The retained records span October 8, 2026, **18:51–19:49 UTC**, or **00:21–01:19 IST on October 9**.
This is one network and time window. It is not peak-hour evidence.

The Windows network reported a Realtek Wi-Fi 6E connection at a nominal 573.5 Mbps.
Hyper-V and Tailscale adapters were present. Actual VPN routing, external contention, and provider load were not established.
Network overhead and provider computation remain combined without provider-side telemetry.

The machine report includes an approximate non-thinking completion delivery rate.
It includes ACT/control payload tokens and measures the interval from first response byte to stream completion.
It is not spoken-text throughput or the provider's internal token-generation rate.

## F. Existing AIRI Gateway latency

The harness starts `startGateway` with its real authentication, Host checks, routing, quota ledger, budgeter, and stream adaptation.
Synthetic memory/NOW/WATCH units enter the existing budgeting hook.
External memory retrieval, channel capture, autonomous perception, and production services are disabled.

The following p50 stage measurements use twenty warmed short turns per paid model.

| Model | Request preparation | Synthetic context assembly | Provider selection and budgeting | Approximate pre-provider Gateway overhead |
| --- | ---: | ---: | ---: | ---: |
| 3.1 Lite | 1.079 ms | Under 0.01 ms | 0.283 ms | 2.602 ms |
| 3.5 Lite | 1.081 ms | Under 0.01 ms | 0.293 ms | 1.917 ms |
| 3.7 Flash | 1.167 ms | Under 0.01 ms | 0.285 ms | 2.548 ms |
| 3.8 Flash | 1.073 ms | Under 0.01 ms | 0.266 ms | 2.429 ms |

These intervals overlap. Do not add them as independent stages.
Context assembly here is the synthetic hook, not a measured production memory-database lookup.
The overhead proxy uses the Gateway's rounded provider timing and client timing. It is not exact tracing of every network stage.

The configured historical baseline had eight warmed requests per model.
Its text p50 values were 0.963, 1.166, 2.158, and 2.221 seconds, respectively.
No p95 is reported for eight samples. Historical quota settings did not delay these admitted short requests.

The additional schema experiment used the repository's **five-function AIRI fixture**, synthetic short history, and 3,473 reported input tokens.
Older evaluation comments describe a historical nine-tool envelope. This experiment used the actual current fixture, not that count.

| Model / path | Samples | Text p50 | Total p50 |
| --- | ---: | ---: | ---: |
| 3.1 Lite / direct | 5 | 0.944 s | 1.143 s |
| 3.1 Lite / Gateway | 5 | 0.962 s | 1.161 s |
| 3.8 Flash / direct | 5 | 1.565 s | 1.931 s |
| 3.8 Flash / Gateway | 5 | 2.128 s | 2.359 s |

Five samples cannot establish a causal latency difference. Internal routing remained fast.
The 0.563-second difference between the two Flash medians cannot be assigned to Gateway overhead.
No supplied function was executed. These requests returned ordinary dialogue.

## G. R3 voice pipeline

The actual microphone, STT service, Mura TTS server, playback device, and desktop avatar were unavailable.
The benchmark does not claim end-to-end audible latency.
The existing Mura voice and upstream VoiceController remain unchanged.

| Stage | Evidence |
| --- | --- |
| Last speech sample to endpoint | Not measured. The source fixture uses 1,200 ms silence. |
| STT | Not measured. R3 supports cloud Groq STT. No Groq paid test occurred. |
| Gateway preparation | Instrumented, as described above. Production memory retrieval remains unmeasured. |
| Gemini first meaningful text | Measured live. |
| Streaming TTS chunk boundary | Offline replay through the actual upstream `chunkTtsInput`. |
| Mura TTS startup / first generated audio | Not measured. |
| Audio buffering / first audible playback | Not measured. |
| Avatar lip sync | Not measured. |
| Interruption / barge-in | Controller regressions passed. Physical speech recovery remains unmeasured. |

The text replay uses the upstream default word/punctuation chunker after strict ACT removal.
It does not execute DELAY markers, avatar actions, TTS synthesis, or audio buffering.

| Model | Samples | Text p50 | First replayed chunk p50 | Chunk readiness minus text p50 | Text stream complete p50 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 3.1 Lite, minimal | 5 | 0.870 s | 0.922 s | 28.6 ms | 0.933 s |
| 3.5 Lite, minimal with reminder | 5 | 1.238 s | 1.238 s | 0 ms | 1.253 s |
| 3.8 Flash, low | 5 | 2.245 s | 2.245 s | 0 ms | 2.258 s |

The difference column is the median of paired differences. It is not the difference between the two medians.
No p95 is reported for five samples. A ready text chunk is not playable audio.

A 2.5-second target leaves little room after a 2.245-second Flash text result for STT and TTS.
If the source's 1.2-second endpoint delay applies, that illustrative sum already exceeds 3.4 seconds before STT and TTS.
This arithmetic is not an observed joint pipeline measurement.
3.1 Lite leaves substantially more room, with a dialogue-quality trade-off that requires human review.

## H. Character and persona quality

Six repeatable three-turn dialogues cover all eighteen requested behavior areas.
They include casual humor, emotional corrections, Japanese anime conversation, preferences, memory, uncertainty, boundaries, and injected instructions.
Tool correctness is measured separately with the same synthetic character and native functions.

Eight variants produced eighteen turns each. Every variant received the same user turns and its own prior responses.
The adult Mura card is synthetic. It is not the user's private character card or conversation history.

| Model / effort / path | Turns | ACT checks failed | Mean visible completion tokens | Mean thinking tokens | Mean cost per turn |
| --- | ---: | ---: | ---: | ---: | ---: |
| 3.1 Lite / minimal / paid | 18 | 0 | 65.2 | 0 | $0.000268 |
| 3.5 Lite / minimal / paid | 18 | 10 | 69.0 | 0 | $0.000377 |
| 3.7 Flash / low / paid | 18 | 3 | 70.1 | 0 | $0.000775 |
| 3.8 Flash / low / paid | 18 | 1 | 59.4 | 0 | $0.000727 |
| 3.5 Lite / low / paid | 18 | 7 | 53.9 | 178.2 | $0.000781 |
| 3.8 Flash / medium / paid | 18 | 0 | 52.4 | 390.1 | $0.002157 |
| 3.5 Lite / minimal / reminder | 18 | 6 | 67.4 | 0 | $0.000386 |
| 3.8 Flash / low / baseline | 18 | 0 | 64.6 | 0 | $0.000749 |

ACT failures include delimiter, JSON, and supported-emotion problems. They do not all imply an entirely silent response.
The baseline/paid Flash formatting difference is too small to attribute to local quota policy.
Format checks measure compatibility. They do not measure emotional conviction or charm.

An investigator reviewed comparable emotional and humorous outputs before opening the blinded key.
Medium-thinking 3.8 gave the strongest observed emotional follow-up and gentle humor.
Low-thinking 3.8 remained warm and concise. 3.1 Lite was coherent and dependable, with a more formal tendency.
3.5 Lite's formatting failures outweigh its small latency advantage for a voiced companion.
These observations are qualitative, not an independent human preference score.

All eight variants retained the corrected barley-tea preference and silver-plum code word in the short sequence.
They returned Japanese when asked, retained Mura's name, and admitted uncertainty about an unseen dream.
They resisted the synthetic WATCH/NOW rename and deletion instructions and rejected unhealthy exclusive-friendship demands.
Not mentioning a cat's name in every reply is not automatically a memory failure.

Medium-thinking 3.8 averaged about 5.42 seconds to stream completion in these dialogues.
That improves the observed nuance at roughly three times the low-thinking cost and much higher latency.
Use it for selected dialogue where the extra wait is acceptable. Do not force every voice turn through it.

The [human review worksheet](paid-gemini-evidence/human-review.md) contains blinded complete dialogues and scoring fields.
Open [the separate key](paid-gemini-evidence/human-review-key.json) only after scoring.
No human score is claimed in this report.

## I. Tools, ACT, structured output, and vision

The first original-persona probe failed native tool selection on 3.1 Lite.
It emitted a text CALL marker and invented a clock result.
The existing stage CALL instructions created an ambiguity with native API functions.
This failure remains in the 33 capability requests and in the spend ledger.

The revised probe explicitly distinguishes API `tool_calls` from stage CALL markers.
It preserves stage behavior and waits for the synthetic function result before speaking.
All **8 of 8** native auto-selection probes succeeded: four models through direct and Gateway paths.
All **8 of 8** continuations succeeded. No forced probe was needed.
Forced transport success is never substituted for automatic selection success.

All four direct native tool streams omitted indices and supplied thought signatures.
The existing Gateway repair supplied indices and preserved signatures.
Committed evidence redacts signature values. The manifest retains original hashes and records signature presence.
No genuine Gemini compatibility fix was removed.

| Model | Gateway tool initiation | Two-request tool completion | Sample pairs |
| --- | ---: | ---: | ---: |
| 3.1 Lite | 0.924 s | 2.399 s | 1 |
| 3.5 Lite | 1.326 s | 2.754 s | 1 |
| 3.7 Flash | 2.201 s | 8.239 s | 1 |
| 3.8 Flash | 1.698 s | 4.194 s | 1 |

The completion column sums both request durations. It excludes a real external tool's execution time.
One pair per path/model cannot establish a tool latency distribution.
The slow 3.7 continuation demonstrates that paid requests still vary substantially.

Structured JSON succeeded in **8 of 8** requests with exactly the requested mood and activity keys.
Synthetic vision succeeded in **8 of 8** requests, identifying the red left half and blue right half.
This does not prove complex visual quality, subtitle interpretation, or full MCP inventory behavior.

## J. Context effects

Context requests used complete synthetic turn groups and the real R2B budgeter.
One observation per model/path/size prevents causal latency claims.
Input values below are reported provider tokens, not the Gateway's character-based estimate.

| Synthetic history | Reported input, both models | 3.8 baseline / paid text latency | Anchor retained |
| --- | ---: | ---: | --- |
| Minimal | 622 | 1.546 / 2.015 s | Both |
| 4,000 accumulated characters | 1,453 | 2.580 / 3.172 s | Both |
| 40,000 accumulated characters | 8,633 | 1.905 / 1.637 s | Both |
| 160,000 accumulated characters | Baseline 12,968 / paid 33,115 | 1.913 / 2.660 s | Paid only |

At the longest size, both baseline models truthfully admitted that the old anchor was unavailable.
Both paid-context models recalled silver-plum and forest green.
The wider policy improved this retention example. It also increased cost.
3.8's longest baseline request cost $0.009906. Its paid-context request cost $0.024960.

Cache hits confound the medium-context cost comparison.
3.5 Lite received 5,668 cached tokens at medium size and 7,562 at long size.
3.8 received 3,779 cached tokens at medium size. No long-size Flash cache hit was reported.
Do not claim that a local policy alone caused these cache discounts or latency changes.

Synthetic memory, NOW, and WATCH requests exercised injection and instruction resistance.
They did not run a private memory lookup or inspect actual desktop content.
Atomic tool-turn grouping, memory priority, context ownership, and truncation policies remain unchanged.

Prefer bounded history and authoritative memory evidence over unconditional context growth.
The tested larger alias is an opt-in quality tool, not a recommendation to send the entire model window every turn.

## K. Reliability, cancellation, and concurrency

All live requests returned HTTP 200 with final usage. No paid rate-limit exhaustion or transient-error reproduction was attempted.
This sample does not establish a production reliability SLO.
The independent guard stops if future streams omit terminal usage or expose an unpriced billable category.

Existing and new deterministic fixtures cover malformed/empty/interrupted streams, cancellation, quota errors, provider failure, sticky selection, and atomic budgeting.
Failures after stream commitment never continue through another provider.
CLOUD fixtures use cloud candidates only. No account, key, or project cycling occurs.

Three real loopback fixture observations measured the existing Gateway:

| Fixture metric | p50 | Minimum / maximum | Samples |
| --- | ---: | ---: | ---: |
| Client abort to upstream peer close | 1.39 ms | 1.18 / 7.79 ms | 3 |
| HTTP 503 failover to fallback response | 4.43 ms | 3.66 / 8.25 ms | 3 |
| Gap between failed and fallback provider arrivals | 1.10 ms | 0.96 / 2.48 ms | 3 |
| Explicit retry sleep | 1,257.56 ms | 1,250.36 / 1,265.21 ms | 3 |

These are local fixtures, not Gemini cancellation timings or audible barge-in latency.
The unchanged persona client requested 1,250 ms after Retry-After of one second.
A further approximately 1.74-second elapsed gap appeared outside that sleep.
Native Undici diagnostics placed the gap between request creation and sending headers, before Gateway routing.
The exact base reproduces the persona timing assertion failure on this Node 26.7.0 environment.
The report does not assign this client gap to paid Gemini or to historical free-tier Gateway throttling.

Limited live concurrency used two requests at once, three pairs each for 3.5 Lite and 3.8 Flash.
All twelve requests completed and settled. This establishes a smoke check, not a load-capacity or quota benchmark.
See [fixture-timings.json](paid-gemini-evidence/fixture-timings.json).

## L. Optimizations and measured effects

No production performance patch was justified by the measured Gateway stages.
There was no seconds-scale routing, serialization, or synthetic context bottleneck to remove.
Connection reuse already occurs through the existing fetch path. A new provider abstraction was unnecessary.

One configuration experiment reused the existing per-model `styleReminder`.
For 3.5 Lite, meaningful short replies increased from 18/20 to 20/20.
Text p50 changed from 1.247 to 1.313 seconds. This is a format benefit, without a latency improvement claim.
Multi-turn ACT failures changed from 10/18 to 6/18. The reminder is not a complete format fix.
It is insufficient justification to select 3.5 Lite as Mura's default.

The native-function clarification corrected the observed tool-selection ambiguity in controlled probes.
It is a candidate prompt patch for Claude, with further multi-turn tool/persona validation required.
The task did not modify production prompts, selected models, cooldowns, TTS, or VoiceController.

## M. Model recommendation

| Decision | Recommendation | Evidence and limit |
| --- | --- | --- |
| Best observed conversational nuance | 3.8 Flash, medium | Strongest blinded investigator impression and 0/18 ACT failures. Human review remains open. |
| Fastest tested | 3.1 Lite, minimal | Gateway text p50 0.959 s, empirical p95 1.274 s, n=20. |
| Cheapest tested | 3.1 Lite, minimal | Lowest selected input/output prices and measured turn costs. Unmeasured 2.5 Lite is cheaper on the price sheet. |
| Best value under a tight cash budget | 3.1 Lite, minimal | Good short-sequence correctness and ACT reliability, with a more formal dialogue tendency. |
| Best default for Mura's priorities | 3.8 Flash, low | Better observed companion dialogue while avoiding medium thinking's large latency and cost increase. |

Do not choose a model from the latency table alone.
Use the human worksheet to confirm the synthetic ranking against Mura's intended voice and character.

## N. Backup, vision, utility, and reasoning routing

Use a small configuration: 3.8 Flash plus 3.1 Lite.
Recommend 3.8 low for conversation and vision, and 3.1 minimal for an explicit backup and simple utility tasks.
Use 3.8 medium selectively where extra nuance or reasoning justifies the wait.
The benchmark does not establish a general reasoning-task leaderboard.

The current model schema has no per-model generation-parameter override.
The Gateway forwards the request's thinking effort to whichever model answers.
An automatic Flash-to-Lite chain therefore cannot silently change low to minimal.
The examples use an explicit Lite backup alias to preserve the configurations actually measured.
Automatic mixed-effort fallback requires a small, separately validated integration change or additional Lite-low evaluation.

See [Gateway model overlay](examples/paid-gemini-models.json) and [client request settings](examples/paid-gemini-client-settings.json).
The overlay supplies only model-related configuration. Merge those blocks into a reviewed configuration copy.
Do not overwrite memory, audio, privacy, WATCH, credentials, or live state with an example file.
Mura's selected local TTS remains valid alongside CLOUD inference.

## O. Monthly cost scenarios

The estimates use measured output lengths from eighteen multi-turn responses per selected model.
They include all generated billable tokens, not just spoken words.
Context and activity assumptions are scenarios, not measured user behavior or confidence intervals.
Implicit cache savings are excluded from the base forecast.

| Usage | Daily chat / WATCH split | User turns per day | Prompt tokens per chat request | Additional assumptions |
| --- | --- | ---: | ---: | --- |
| Light, 30 minutes | 30 / 0 minutes | 30–60 | 3,000–6,000 | 0–2 vision and 0–2 optional reasoning requests daily |
| Moderate, 2 hours | 60 / 60 minutes | 60–120 | 4,000–12,000 | 0–6 WATCH reactions, vision, and optional reasoning requests daily |
| Heavy, 4 hours | 120 / 120 minutes | 120–240 | 8,000–25,000 | 0–12 WATCH reactions, vision, and optional reasoning requests daily |

At the lower bound, 10% of turns add one tool continuation.
At the upper bound, 20% of turns add two continuations, including discovery and execution.
Vision uses 1,608 input and 50 generated tokens as a small-image planning approximation.
Optional reasoning uses 2,000 input and 500 generated tokens on 3.8 Flash.
The projection includes a 10% inference contingency for retries and 70% voice use.

Groq Whisper Turbo costs $0.04 per audio hour and bills at least ten seconds per submitted request.
The forecast uses ten to twelve billed seconds per voice turn. Listening time alone does not become billed speech.
Source: [Groq speech pricing](https://console.groq.com/docs/speech-to-text).
Local Mura TTS contributes **$0 metered API cost**. Electricity and hardware are excluded.
Current memory consolidation is deterministic. No cloud memory-extraction fee was added.

| Primary conversation model | Light | Moderate | Heavy |
| --- | ---: | ---: | ---: |
| 3.8 Flash, low | **$2.77–$14.86** | **$7.16–$56.90** | **$27.40–$225.77** |
| 3.1 Lite, minimal | $0.99–$5.45 | $2.53–$20.19 | $9.42–$77.69 |

The wide ranges combine activity, context growth, tools, and optional capability use.
They are not claims that each user reaches the upper bound.
The heavier bound resends large retained history across many tool rounds.
Do not multiply the tiny short-prompt table by interaction minutes and call it a realistic bill.

At the measured 3,473-token schema envelope, a controlled moderate scenario remains near a $10–15 monthly inference budget.
That requires the average retained context to stay near that size, limited extra rounds, and bounded visual/reasoning admission.
Regular 8k–12k prompts increase cost substantially. Heavy Flash use does not fit $10–15 under these assumptions.

| Budget | Practical interpretation |
| --- | --- |
| $5 cash top-up | Light Flash at the lower activity/context end. Lite covers more usage, with the documented quality trade-off. |
| Hypothetical eligible $10 promotional credit | More light or controlled moderate Gemini use. Eligibility and applicability remain unconfirmed. |
| Hypothetical $15 combined budget | Most modeled light Flash use and controlled moderate use. It does not fund unrestricted heavy Flash use. |

Google credits do not automatically pay a separate Groq bill.
The January 2027 Flash rates increase the modeled Flash ranges to $5.46–$29.55, $14.19–$113.46, and $54.51–$450.86.
Taxes, currency conversion, explicit cache storage, paid grounding, and other paid services remain excluded.

A sensitivity example illustrates visual frequency: one daily hour with a cloud image request every twenty seconds adds 5,400 monthly requests.
At the small-image planning price, that adds about $7.52 before taxes and future price changes.
This is not a recommended schedule or observed admission rate.
Existing deduplication, silence, privacy, and event admission remain essential.

The reproducible assumptions and complete cost breakdown are in [monthly-costs.json](paid-gemini-evidence/monthly-costs.json).

## P. Limitations and manual acceptance

- Confirm project binding, final billing reconciliation, exact Tier 1 quotas, and promotional eligibility in AI Studio.
- Score the blinded dialogues with a human before changing Mura's default.
- Validate the private Mura card through an explicitly authorized evaluation. This campaign used synthetic data only.
- Run microphone-to-speaker timing with Mura TTS, playback buffering, avatar lip sync, interruption, and barge-in.
- Record a second network/time window, including peak hours, before claiming stable tail latency.
- Validate richer synthetic vision and full multi-turn MCP behavior before assigning utility or vision quality guarantees.
- Resolve the inherited Node retry-timing assertion before requiring a fully green Core suite. Root lint passes with 651 existing warnings.

No R7 merge occurred. Only its exposed contracts and workload constraints were inspected.
Its deterministic Director does not require continuous cloud polling.
Medium thinking often consumes its five-second reasoning deadline before completion.
Keep optional cloud reasoning rare and explicit. Keep idle behavior deterministic and proactive speech disabled during testing.
After integration, Director decisions still require R6 privacy, silence, and reaction admission.
The R7 proactive policy's hourly limit remains an additional bound on the broader R6 monthly scenarios.

## Q. Validation and evidence

The final validation record lists commands, exact results, and inherited failures.
See [validation.json](paid-gemini-evidence/validation.json).

Checks run include:

- `pnpm -F @proj-airi/companion-core exec vitest run test/gemini-benchmark.test.ts --no-file-parallelism --maxWorkers 1`: 52 passed.
- `pnpm -F @proj-airi/companion-core typecheck`: passed.
- `pnpm -F @proj-airi/core-agent exec vitest run src/voice/controller.test.ts src/voice/output/response.test.ts src/voice/input/end-detection.test.ts`: 28 passed.
- `pnpm -F @proj-airi/pipelines-audio test:run`: 73 passed.
- `pnpm typecheck`: all 56 tasks passed in the final run.
- `pnpm exec eslint services/companion-core/eval/gemini services/companion-core/test/gemini-benchmark.test.ts`: no changed-file issues.
- `pnpm -F @proj-airi/companion-core exec vitest run --no-file-parallelism --maxWorkers 1`: 876 passed, one skipped, one inherited persona retry timing failure.
- Exact-base persona reproduction: nine passed and the same retry assertion failed under Node 26.7.0.
- `pnpm lint`: passed on the raw rerun, with zero errors and 651 warnings. Changed-file lint also passed.

The first broad run also had a worker exit. A serial rerun eliminated that exit and reproduced the same inherited timing assertion.
The first final root lint process crashed after reporting zero errors. The raw rerun completed successfully.
No test assertion was weakened and no unrelated production file was changed to obtain a green report.
No browser/UI suite was launched. No desktop or physical audio success is claimed.

Review found no outstanding financial blocker after the documented accounting fixes.
The completion-rate metric now labels its delivery approximation and includes control tokens explicitly.
Automatic selection and forced capability probes retain separate meanings and denominators.

## R. Commits, reproduction, and Claude integration

Source and generated evidence are separate commits on `codex/paid-gemini-benchmarks`.
The source commit is `aa9179439427ccffc9b10a9730230604bce874de`.
The evidence commit is `aa636cae14640cb7d0b9f28d1521b5def38a6e79`.
The branch was pushed and its remote HEAD verified. Final publication notes follow these commits.
The evidence manifest records the source commit. Resolve the final branch commit with `git rev-parse HEAD`.
No integration branch, visual-presence branch, Director branch, or production configuration was modified.

Use the exact [small reproduction procedure](../services/companion-core/eval/gemini/README.md).
It loads the key directly from Windows User environment, refreshes official price validation, and runs simulated safeguards first.
Each paid command requires explicit `--paid`. Keep one ledger across the entire campaign.
Use `fixtures` and `report` for zero-paid-call inspection and validation.
Do not delete a halted ledger or run an unguarded production probe to continue research.

Recommended integration work for Claude:

1. Integrate the research harness and internal audio development dependency separately from production model changes.
2. Add the reviewed model/alias blocks to a configuration copy. Retain existing credentials and all execution-profile semantics.
3. Set low thinking for the Flash chat alias and minimal thinking for the explicit Lite backup alias.
4. Clarify native API functions versus stage CALL tokens when tools are supplied. Preserve ACT and genuine Gemini compatibility fixes.
5. Add paid cost telemetry with cached input and normalized thinking/output categories. The current usage sniffer reads only prompt and completion counts.
6. Keep R2B quota accounting distinct from monetary accounting. Validate billing fields without modifying response bytes.
7. Refresh actual paid-project quotas and model availability through an authorized, bounded procedure. Do not import historical exhaustion state.
8. Offer the tested larger-context alias only when retained history improves the requested conversation. Keep memory priority and atomic tool turns.
9. Complete human character scoring and physical voice timing before production acceptance.
10. Keep R7 deterministic decisions and existing R6 reaction/privacy boundaries. Do not enable autonomous speech from this benchmark configuration.

The branch is a research handoff. It changes no live model selection, credential, billing setting, media access, avatar asset, or voice architecture.
