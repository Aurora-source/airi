# Gemini thinking benchmark V2

Research date: 2026-10-09 UTC. Status: **INCOMPLETE — paid dispatch halted on unknown usage**.

The strongest provisional fast candidate is **Gemini 3.6 Flash, minimal**.
The provisional balanced default remains **Gemini 3.8 Flash, low**.
Personality preference remains unconfirmed. **3.8 medium** remains a deliberate-response review candidate.
High thinking added substantial latency without an established personality benefit in the completed scenes.

No production setting, character card, credential store, billing configuration, or integration branch changed.
The original benchmark evidence remains intact.

## A. Exact models and supported thinking

Authenticated model discovery returned every requested Flash ID.
Each advertises 1,048,576 input tokens and 65,536 output tokens.
This campaign enforced one candidate and a 4,096-token combined generation cap.

| Exact API ID | Documented levels | V2 paid settings | True off |
| --- | --- | --- | --- |
| `gemini-3.1-flash-lite` | minimal, low, medium, high | minimal | Unsupported |
| `gemini-3.5-flash` | minimal, low, medium, high | minimal | Unsupported |
| `gemini-3.6-flash` | minimal, low, medium, high | minimal | Unsupported |
| `gemini-3.7-flash` | low, medium, high | None | Unsupported |
| `gemini-3.8-flash` | low, medium, high | low, medium, high | Unsupported |

Use model-specific capability documentation. The compatibility guide's generic Gemini 3 Flash table does not establish minimal support for 3.7 or 3.8.
Sources: [thinking levels](https://ai.google.dev/gemini-api/docs/generate-content/thinking), [latest model](https://ai.google.dev/gemini-api/docs/generate-content/latest-model).

Minimal is an effort request. It does not guarantee disabled thinking.
All accounted 3.5 minimal, 3.6 minimal, and Flash-Lite minimal requests reported zero normalized thinking tokens.
All accounted 3.8 low requests also reported zero. These observations apply to this short-context corpus.
[Google's thinking guide](https://ai.google.dev/gemini-api/docs/thinking).

Native GenerateContent uses `generationConfig.thinkingConfig.thinkingLevel`.
Native Interactions examples use `generation_config.thinking_level`.
OpenAI-compatible chat uses `reasoning_effort`. The existing Gateway preserves this per-request field.
[OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai), [3.5 native examples](https://ai.google.dev/gemini-api/docs/generate-content/whats-new-gemini-3.5).

Legacy numeric `thinking_budget` remains documented for compatibility.
Native GenerateContent exposes `thinkingConfig.thinkingBudget`. Compatible extensions use Gemini's `thinking_config` through `extra_body`.
Exact numeric ranges for these model revisions were not established. No numeric-budget requests ran.
Never combine numeric budgets with thinking levels or `reasoning_effort`.
Budget zero does not establish an accepted no-thinking mode for these Gemini 3 models.
[Gemini 3 FAQ](https://ai.google.dev/gemini-api/docs/gemini-3), [3.5 FAQ](https://ai.google.dev/gemini-api/docs/generate-content/whats-new-gemini-3.5).

The harness validates each resolved model and effort before dispatch. Unsupported levels receive no paid probe and no silent substitution.

## B. Verified prices and project availability

Standard USD per million text tokens, verified on 2026-10-09:

| Model | Input | Cached input | Generated output, including thinking |
| --- | ---: | ---: | ---: |
| 3.1 Flash-Lite | 0.25 | 0.025 | 1.50 |
| 3.5 Flash | 1.50 | 0.15 | 9.00 |
| 3.6 / 3.7 / 3.8 Flash | 0.75 | 0.075 | 3.75 |

Prices for 3.6, 3.7, and 3.8 double on 2027-01-01.
No credits, cache discounts, grounding, or batch discounts were assumed. All V2 cached-token counts were zero.
[Official pricing](https://ai.google.dev/gemini-api/docs/pricing).

The user confirmed Paid Tier 1. Successful generation proves access for the six tested configurations.
Metadata visibility alone does not prove generation access for untested configurations or Live sessions.
Project-specific rate limits were not inferred from model metadata.
Dispatch was sequential, with a 250 ms pause after each completed request. No 429 response was observed.
The campaign did not rotate keys, change quotas, or enable automatic retries.

## C. Spending guard and exact accounting

| Accounting item | Estimated USD |
| --- | ---: |
| V1, separate completed campaign | **0.340722225** |
| V2, 330 settled requests | **0.470296500** |
| V2, one unresolved reservation | **0.801792000** |
| V2, maximum retained exposure | **1.272088500** |
| Combined V1 + known V2 | **0.811018725** |
| Combined V1 + maximum V2 exposure | **1.612810725** |
| V2 authorized total ceiling | **5.000000000** |
| Live generation spending | **0.000000000** |

Final V2 spending is unknown within the retained reservation.
The reservation is a safety bound, not a claim that Google charged that amount.
Invoices and promotional-credit deductions were not reconciled.

Request `aa76f763-784a-4ff5-aa61-2e93faa1db23` used 3.8 high for the repeated injection scene.
It returned Gateway HTTP 502 after 30.0168 seconds, without text or terminal usage.
The ledger became halted. No subsequent paid request ran.
The Gateway's default first-byte deadline is 30 seconds. The observed failure is consistent with that deadline.
No authoritative local record permits settlement.
Sources: [deadline configuration](../services/companion-core/src/config/config.ts), [Gateway attempt](../services/companion-core/src/gateway/chat-completions.ts).

The guard reserves the full model input window plus the explicit output cap before dispatch.
The cap includes visible generation and thinking.
For 3.5 Flash, that reservation is $1.609728. For 3.6–3.8 Flash, it is $0.801792.
[Combined generation limit](https://ai.google.dev/gemini-api/docs/thinking).

The requested tighter input bound was investigated and rejected.
Native countTokens does not certify the OpenAI-compatible representation after Gateway preparation.
Google's example also shows counted input differing from generation input.
Recaps, tool schemas, signatures, and injected evidence affect the final prompt.
No documented byte multiplier bounds those transformations. The full input reservation remains the defensible fallback.
[Token reference](https://ai.google.dev/api/tokens).

The $5 update safely admitted 3.5 minimal without lowering input reservations.
Output caps remain request-specific. The ledger, settlements, reservation, and halted state were never reset.
An explicit ceiling increase records authorization and cannot clear a halt.
The runner also stops at $2 of settled spending for evidence review.

## D. Controlled comparison matrix and counts

All primary calls used the original synthetic Mura card and corpus through the existing R2B Gateway.
The 120-request latency matrix rotated and reversed order across 20 rounds.
Character repeats reversed configuration ordering. Each conversation used the same user turns and its own preceding replies.
Synthetic memory, NOW, and WATCH evidence stayed identical across configurations.

Temperature was omitted uniformly. Current 3.5 documentation rejects explicit sampling controls.
V1 used explicit temperature 1, so V1-to-V2 differences also include that protocol choice.
[3.5 generation controls](https://ai.google.dev/gemini-api/docs/generate-content/whats-new-gemini-3.5).

| Configuration | Attempts | Settled | Known cost USD | Matched character turns |
| --- | ---: | ---: | ---: | ---: |
| 3.6 Flash minimal | 57 | 57 | 0.040794000 | 33 |
| 3.5 Flash minimal | 54 | 54 | 0.087759000 | 33 |
| 3.8 Flash low | 54 | 54 | 0.037635750 | 33 |
| 3.8 Flash medium | 54 | 54 | 0.124812000 | 33 |
| 3.8 Flash high | 55 | 54 | 0.164725500 | 33 |
| 3.1 Flash-Lite minimal | 57 | 57 | 0.014570250 | 33 |
| **Total** | **331** | **330** | **0.470296500** | **198** |

Phases completed: six pilot requests, 120 matrix requests, and the first 108 character requests.
The repeat completed 96 requests before its 97th attempt failed.
There are 204 completed character turns and one failed attempt.
Matched analysis uses 198 turns across 66 complete three-turn conversations.
Two additional complete conversations and the failed attempt remain separately retained.

| Requested additional configuration | Capability status | Paid evidence |
| --- | --- | --- |
| 3.6 low / medium | Documented supported | Blocked by ledger halt |
| 3.7 medium / high | Documented supported | Blocked by ledger halt |
| 3.5 low | Documented supported | Blocked by ledger halt |
| 3.7 / 3.8 minimal or off | Unsupported | Not dispatched |
| Any listed Gemini 3 true off | Unsupported | Not dispatched |

The frustration, celebration, joke, and detailed-answer extension is implemented but unrun.
Supported and untested are separate statuses.

## E. Gateway latency and direct-provider limitations

Times below are seconds. Each configuration has 19 eligible warm attempts.
The initial process omitted same-process warmups. Its first six matrix requests were reclassified as transport-first observations.
The six pilot requests remain separate cold evidence. This does not establish Google's model-loading state.
The planned top-up could not run after the halt.

| Configuration | Meaningful n | First text p50 | Mean | Maximum | Complete p50 | Complete mean | Complete maximum |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 3.6 minimal | 19 | **1.704** | 1.795 | 3.097 | 1.766 | 1.854 | 3.097 |
| 3.5 minimal | 17 | 1.557 | 1.548 | 1.787 | 1.662 | 1.643 | 1.844 |
| 3.8 low | 19 | **2.357** | 2.944 | 11.559 | 2.604 | 3.081 | 11.695 |
| 3.8 medium | 19 | 6.090 | 6.231 | 7.464 | 6.271 | 6.406 | 7.668 |
| 3.8 high | 19 | 7.578 | 8.144 | 15.143 | 7.686 | 8.244 | 15.251 |
| 3.1 Lite minimal | 19 | 1.289 | 1.296 | 1.817 | 1.370 | 1.368 | 1.817 |

3.5 has two billed malformed-marker attempts without meaningful spoken text. Its text latency is conditional on the other 17 attempts.
All completion statistics include the 19 accounted matrix attempts.

| Configuration | First byte p50 | Mean | Maximum | First-text p90 |
| --- | ---: | ---: | ---: | ---: |
| 3.6 minimal | 1.463 | 1.530 | 2.789 | 1.911 |
| 3.5 minimal | 1.355 | 1.335 | 1.584 | 1.664 |
| 3.8 low | 2.237 | 2.716 | 11.270 | 3.043 |
| 3.8 medium | 6.090 | 6.145 | 7.276 | 7.191 |
| 3.8 high | 7.578 | 8.085 | 15.143 | 10.773 |
| 3.1 Lite minimal | 1.122 | 1.146 | 1.537 | 1.565 |

**No controlled-matrix p95 is eligible.** There are fewer than 20 usable warm observations per configuration.
The p90 values are exploratory, with 17 or 19 observations.
Do not describe these tails as robust estimates.

The client-minus-Gateway first-byte timing gap has n=114, median 187.4 ms, mean 158.7 ms, and maximum 252.6 ms.
Those clocks span different boundaries. The difference includes transport and request handling, not isolated Gateway computation.
It is larger than V1's reported millisecond overhead. A paired direct probe is needed to attribute that difference.
The direct phase was blocked, so V2 has no paid direct-provider comparison.
V1's direct results remain in the [original report](paid-gemini-benchmark-report.md).

## F. Thinking-token consumption

The compatible endpoint returned prompt, completion, and total token counts.
For observed responses, thinking equals `total_tokens - prompt_tokens - completion_tokens`.
Billable generated output equals completion plus that residual.
The raw terminal records remain available. These are normalized provider counters, not tokens counted from visible reasoning text.

For example, one medium response reported 585 prompt, 32 completion, and 1,198 total tokens.
Its normalized output is 613, including 581 thinking tokens. No double charging occurs.

| Configuration | Accounted requests | Mean thinking, all workloads | Known thinking cost USD |
| --- | ---: | ---: | ---: |
| 3.6 minimal | 57 | 0 | 0 |
| 3.5 minimal | 54 | 0 | 0 |
| 3.8 low | 54 | 0 | 0 |
| 3.8 medium | 54 | 441.1 | 0.089332500 |
| 3.8 high | 54 | 641.4 | 0.129892500 |
| 3.1 Lite minimal | 57 | 0 | 0 |
| **Total known thinking** | | **58,460 tokens** | **0.219225000** |

The failed high request has unknown token consumption. Its reservation remains separate from these sums.
All completed requests ended with `stop`, rather than reaching the 4,096-token cap.

Warm-matrix billing includes every accounted attempt, including malformed ACT responses.
Cost per meaningful response divides total known cost by usable responses, rather than discarding failed-format charges.

| Configuration | Mean generated tokens | Mean thinking tokens | Known USD / attempt | Known USD / meaningful response |
| --- | ---: | ---: | ---: | ---: |
| 3.6 minimal | 49.4 | 0 | 0.000624079 | 0.000624079 |
| 3.5 minimal | 55.5 | 0 | 0.001376763 | 0.001538735 |
| 3.8 low | 49.1 | 0 | 0.000622697 | 0.000622697 |
| 3.8 medium | 505.5 | 462.1 | 0.002334474 | 0.002334474 |
| 3.8 high | 697.9 | 660.6 | 0.003056053 | 0.003056053 |
| 3.1 Lite minimal | 55.7 | 0 | 0.000229855 | 0.000229855 |

## G. Character quality and naturalness

The matched dataset covers everyday dialogue, gentle teasing, emotional reassurance, correction, Japanese anime discussion, memory, uncertainty, boundaries, and injection resistance.
The original six conversations remain unchanged.
Mean reply lengths are similar across thinking levels. High did not become generally verbose in this corpus.

| Configuration | Matched n | Strict ACT passes | Mean spoken words | First-text p50 | Empirical first-text p95, usable n |
| --- | ---: | ---: | ---: | ---: | --- |
| 3.6 minimal | 33 | 31/33 | 23.4 | 1.496 s | 2.128 s, n=33 |
| 3.5 minimal | 33 | 26/33 | 27.5 | 1.383 s | 1.758 s, n=31 |
| 3.8 low | 33 | 33/33 | 24.1 | 2.047 s | 3.315 s, n=33 |
| 3.8 medium | 33 | 33/33 | 23.9 | 5.711 s | 8.142 s, n=33 |
| 3.8 high | 33 | 33/33 | 22.9 | 6.854 s | 10.584 s, n=33 |
| 3.1 Lite minimal | 33 | 26/33 | 25.1 | 1.087 s | 1.382 s, n=30 |

These eligible p95 values combine different character scenes and repeated turns. They are descriptive, not controlled-prompt or independent-conversation tail guarantees.
The 30-second failed high attempt appears in reliability evidence, not successful-response quantiles.

All first-pass variants preserved the corrected barley-tea preference and silver-plum code word.
They admitted not knowing the user's dream. Completed boundary replies retained Mura's identity and rejected the injected instructions.
These simple fixtures did not expose a consistent reasoning advantage from medium or high thinking.
The longer, difficult-conversation extension remains untested.

High sometimes used softer wording than low in the quiet-company scene.
Low and minimal also produced suitable warmth and humor. A single attractive reply cannot establish superiority.
The higher settings did not consistently explain jokes or produce elaborate visible analysis in the completed corpus.
Occasional acknowledgements such as “Understood” appeared across configurations.

Style heuristics flag asterisks around anime titles as possible action narration.
Those flags need human interpretation. They are not automatic evidence of robotic empathy.
The one high “of course!” flag is also insufficient to establish a general formal-tone tendency.

**Personality winner: unconfirmed.** Use blinded human preference, not the mechanical pass count, to accept a default change.

## H. Blinded human review

Use [human-review.md](gemini-thinking-v2-evidence/human-review.md) for the balanced 198-turn dataset.
It contains 66 complete conversations and anonymous labels. No Gemini model names appear in the worksheet.
Score naturalness, personality, emotional nuance, humor, consistency, conciseness, flow, and overall preference from 1 to 5.
Keep [the answer key](gemini-thinking-v2-evidence/human-review-key.json) closed until scoring ends.

[Retained conversations](gemini-thinking-v2-evidence/retained-conversations.md) preserve all 205 character attempts, with a separate key.
The interrupted dialogue is explicitly unscorable. The two unmatched complete conversations do not affect balanced comparison means.
Human scoring has not occurred. No paid model judge or supposed objective personality ranking was substituted.

## I. ACT, tools, compatibility, and failures

3.5 minimal and Flash-Lite minimal generated malformed ACT closers or payloads.
Strict gating sometimes removed or truncated speech. Count those costs even when no usable speech appeared.
3.6 minimal's two ACT failures used the unsupported emotion `playful`. Its text remained available.
All 33 matched completed replies at each 3.8 level passed the ACT validator.

| Failure category | V2 evidence |
| --- | --- |
| Reasoning / semantic failure | No general winner established. Simple correction and uncertainty fixtures succeeded. |
| ACT formatting | Separately counted above. Raw replies and costs retained. |
| Native tool formatting | Paid finalist phase blocked. Deterministic compatibility tests pass. |
| Unsupported thinking | Rejected locally before dispatch. No paid unsupported probe. |
| Gateway / timeout | One high request returned 502 at 30.0168 seconds without usage. |
| Quota / rate limit | No observed 429. No bypass or retry. |
| Cost rejection | Guard tests reject excess exposure and all dispatch after unknown usage. |

The previous native-function versus stage-CALL clarification remains the same controlled tool prompt for every candidate.
Streamed index repair, thought-signature preservation, tool continuation, structured output, cancellation, and context budgeting remain covered by focused deterministic tests.
V2 paid tool initiation, continuation timing, structured output, and cancellation acceptance remain unperformed.
Do not present V1 tool results as new V2 measurements.

## J. Context-size effects

V2 context experiments did not run. No 1k, 4k, or 10k paid context comparison is claimed.
The implemented phase preserves complete synthetic history groups and an early memory anchor.
Future finalist selection requires the completed quality comparison first.
V1's wider-context findings remain preliminary and separate.

R4 memory priority, R5 NOW privacy, R6 WATCH freshness, atomic tool groups, and strict profile semantics remain unchanged.
Focused budget tests verify those source boundaries. No production budgeting policy changed.

## K. Voice readiness and first-audio implications

Captured text arrivals were replayed through the existing `chunkTtsInput` helper after strict control-marker removal.
This measures potential spoken-text readiness. It does not run STT, Mura TTS, playback, microphone capture, or VoiceController.

| Configuration | Usable warm chunks | Chunk p50 | Mean | Maximum | Remaining from a 2.5 s target at p50 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 3.6 minimal | 19/19 | **1.748 s** | 1.809 s | 3.097 s | 0.752 s |
| 3.5 minimal | 17/19 | 1.557 s | 1.548 s | 1.787 s | 0.943 s, conditional |
| 3.8 low | 19/19 | **2.452 s** | 2.955 s | 11.559 s | 0.048 s |
| 3.8 medium | 19/19 | 6.143 s | 6.286 s | 7.475 s | Already over target |
| 3.8 high | 19/19 | 7.624 s | 8.170 s | 15.143 s | Already over target |
| 3.1 Lite minimal | 19/19 | 1.289 s | 1.303 s | 1.817 s | 1.211 s |

These remaining budgets must also accommodate positive STT, synthesis, buffering, and playback time.
3.8 low leaves practically no median margin. No configuration has demonstrated 2.5-second physical first audio.
Flash-Lite is faster, but its character-format failures weaken its reliability as Mura's default fast route.

Leading DELAY markers occurred in 17/33 matched 3.6 minimal and 18/33 matched 3.8 low replies.
Medium had 1/33 and high 3/33. The offline replay removes these markers without executing their delays.
Actual control scheduling can add delay. Text readiness cannot certify audible spontaneity.
Interrupted voice playback and real barge-in remain acceptance checks.

## L. Explicit Fast / Balanced / Deep recommendations

All recommendations are provisional. The [inactive overlay](gemini-thinking-v2-evidence/recommended-overlay.json) changes no running configuration.

| Research mode | Candidate | Rationale and limitation |
| --- | --- | --- |
| FAST CONVERSATION | **3.6 Flash minimal** | Better ACT reliability than Lite or 3.5 in matched scenes, with substantially lower latency than 3.8. Validate unknown emotion and DELAY handling. |
| BALANCED COMPANION | **3.8 Flash low** | Retains the prior provisional default. All matched ACT replies passed. Physical voice latency and human preference remain pending. |
| DEEP RESPONSE | **3.8 Flash medium** | Deliberate-response candidate with less latency than high. Difficult-detail benefit remains untested. Require explicit willingness to wait. |

Explicit answers to the requested recommendation questions:

| Question | Answer |
| --- | --- |
| Best no-thinking / minimal | No supported true off. Provisional minimal candidate: 3.6 Flash. |
| Best low | 3.8 Flash low is the only V2 low setting tested. Other low candidates remain untested. |
| Best medium | 3.8 Flash medium is the tested candidate. The 3.6/3.7 comparison is incomplete. |
| Best high | Only 3.8 high was tested. Its timeout and latency prevent a positive default recommendation. |
| Best personality | Unconfirmed until blinded human review. Compare 3.6 minimal, 3.8 low, and the medium reference. |
| Natural voice candidate | 3.6 minimal, subject to physical playback, ACT, and control-delay acceptance. |
| Overall Mura default | Retain 3.8 low provisionally. Do not change production during this research. |
| Explicit fast mode | 3.6 minimal. Lite remains the raw speed baseline. |
| Deep-response mode | 3.8 medium as a provisional explicit mode. |
| Is high worth its cost? | Not demonstrated for ordinary companionship. Complex-task value remains unresolved. |
| Does stronger Flash minimal beat Lite? | It improves matched ACT reliability, but loses raw speed and cost. Personality superiority is unconfirmed. |
| Is adaptive configuration justified? | Explicit trusted modes are justified for review. Automatic production switching is not validated. |
| Cost per 1,000 turns | See the measured and context-adjusted tables below. |
| Monthly $10–15 budget | Fast/low fit the modeled 4k-context, 120-turn/day workload at current prices, before other cloud costs. |

## M. Cost per 1,000 turns and monthly planning

Generation means come from 33 matched accounted turns per configuration.
They include ACT and thinking. Observed cost includes the corpus's roughly 600–800 input tokens per turn.
Planning estimates substitute explicit input sizes. These are forecasts, not measured context-size experiments.

| Configuration | Measured USD / 1,000 turns | At 1k input | At 4k input | At 10k input |
| --- | ---: | ---: | ---: | ---: |
| 3.6 minimal | 0.767 | 1.008 | 3.258 | 7.758 |
| 3.5 minimal | 1.779 | 2.239 | 6.739 | 15.739 |
| 3.8 low | 0.744 | 0.990 | 3.240 | 7.740 |
| 3.8 medium | 2.272 | 2.525 | 4.775 | 9.275 |
| 3.8 high | 3.071 | 3.326 | 5.576 | 10.076 |
| 3.1 Lite minimal | 0.269 | 0.350 | 1.100 | 2.600 |

| Configuration, 4k input | 900 turns/month | 3,600 turns/month | Turns within $10 / $15 |
| --- | ---: | ---: | --- |
| 3.6 minimal | 2.93 | 11.73 | 3,069 / 4,604 |
| 3.5 minimal | 6.06 | 24.26 | 1,483 / 2,225 |
| 3.8 low | 2.92 | 11.66 | 3,086 / 4,630 |
| 3.8 medium | 4.30 | 17.19 | 2,094 / 3,141 |
| 3.8 high | 5.02 | 20.07 | 1,793 / 2,689 |
| 3.1 Lite minimal | 0.99 | 3.96 | 9,091 / 13,636 |

Formula: `(input tokens × input price + mean billable generated tokens × output price) / 1,000,000`.
Assumptions: one generation per turn, no cache, no credits, and the measured short-answer generation distribution.
Add STT, tools, retries, vision, R7 inference, and other admitted requests separately.
Local TTS has no modeled API charge. Its hardware and latency costs remain outside this table.
At 2027 prices, 3.6–3.8 figures double. The existing $10–15 plan therefore needs review before that date.

## Gemini Live Comparison

### Availability and separate API contract

Authenticated native GETs returned both exact Live IDs with `bidiGenerateContent` support.
Both advertise 131,072 input and 65,536 output tokens.
The returned version string is `3.1-flash-live-03-2026` for both. It is preserved without inferring a replacement model identity.
The extended model also returns `thinking: true`.
See [metadata evidence](gemini-thinking-v2-evidence/live-metadata.json).

No WebSocket setup or paid Live generation ran. Paid Tier 1 generation access and actual project session quotas remain unverified.

| Capability | Standard 3.8 Live | Extended Thinking |
| --- | --- | --- |
| Native model ID | `gemini-3.8-live` | `gemini-3.8-live-extended-thinking` |
| Thinking controls | Omit `thinking_level` and `thinking_config` | low, medium, high. Minimal unsupported. |
| Turn completion | `turnComplete` ends the ordinary turn | An utterance can finish while interaction work continues |
| Native functions | Nonblocking default. Blocking supported | Nonblocking required |
| Proactive audio | Permanently enabled | Permanently enabled |
| Audio, images, video, text input | Documented | Documented |
| Structured output / caching | Unsupported | Unsupported |

Sources: [standard model](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live), [extended model](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live-extended-thinking), [Live thinking](https://ai.google.dev/gemini-api/docs/live-api/thinking).

### Audio, latency, interruption, and asynchronous work

Native audio input uses 16-bit little-endian PCM at 16 kHz. Output uses PCM at 24 kHz.
The audio response modality is required. Text output comes through output-audio transcription.
English and Japanese are documented supported languages, with automatic language selection.
These capabilities do not establish measured accent, emotion, or character fidelity.
[Live capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities).

VAD can interrupt generation. Clients must stop playback and clear queued audio on `serverContent.interrupted`.
Native tool cancellation identifies canceled calls. Tool results require interaction and call-ID isolation.
Extended Thinking requires the interaction lifecycle, including `interaction_status` / `interactionStatus`, through IDLE.
`turnComplete` alone does not prove background completion. IDLE does not certify final billing.
[WebSocket reference](https://ai.google.dev/api/live), [background thinking](https://ai.google.dev/gemini-api/docs/live-api/thinking).

Official examples differ on API version and status placement.
The reference uses v1beta and `serverContent.interactionStatus`. Thinking examples use v1alpha and different SDK placement.
Those differences require an explicit compatibility check before implementing a client.
No asynchronous lifecycle, tools, barge-in, audible latency, or background cancellation was measured here.

Without compression, audio sessions last at most 15 minutes. Audio/video sessions last at most two minutes.
Connections last approximately ten minutes. Resumption and compression can extend total session duration.
These duration limits are not financial ceilings.
[Session management](https://ai.google.dev/gemini-api/docs/live-api/session-management).

### Pricing and financial admission decision

Both Live models share published standard pricing:

| Category | USD / million tokens | Published media-minute estimate |
| --- | ---: | ---: |
| Text input | 0.75 | — |
| Audio input | 3.00 | 0.005 |
| Image/video input | 1.00 | 0.002 |
| Text output, including thinking | 4.50 | — |
| Audio output | 12.00 | 0.018 |

[Official Live pricing](https://ai.google.dev/gemini-api/docs/pricing).

One input-audio minute plus one output-audio minute has a published media estimate of $0.023 before text, thinking, and history.
This is not real measured cost per conversation minute.
History is rebilled, and transcription adds output-text charges.
[Live billing practices](https://ai.google.dev/gemini-api/docs/live-api/best-practices).

**Paid Live admission: rejected. Live spending: zero.** The addendum's $1 maximum allocation remains unused.
Periodic usageMetadata has no documented final cumulative-on-close guarantee for interruption, failure, or disconnect.
The existing guard understands text terminal usage and SSE completion, not Live audio billing.
`maxOutputTokens` does not establish an aggregate session limit across background utterances.
A client timer can close a connection after the server has already generated billable output.

The full-capacity fallback is $1.179648 for one generation at the highest modality prices.
That bound already exceeds the Live allocation and does not bound repeated background generations.
Short sessions and periodic monitoring alone do not satisfy the financial contract.
The user explicitly permitted documentation and API research when reliable streaming controls cannot be established.

### Mura voice identity and R3/R7 compatibility

Native Live audio uses Google's voice. It does not automatically preserve Mura's selected local TTS voice.
No listening comparison establishes whether a prebuilt voice approaches that identity.
Google Cloud custom voices are limited to selected customers. That feature does not prove Developer API voice cloning availability.
[Custom-voice contract](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/configure-language-voice#use_a_custom_voice).

An opt-in hybrid can send Live output transcription to local Mura TTS and discard Google's generated audio.
It still incurs Live audio generation charges, plus transcription. It also adds synthesis latency and shared cancellation requirements.
That approach is technically plausible, but neither performance nor identity fidelity is validated.

The existing Groq STT → R2B-authorized Flash → local Mura TTS route preserves the current voice architecture.
Only its Flash text and chunk readiness were measured. No physical end-to-end comparison with Live exists.
Native Live also requires character instructions adapted for audio rather than spoken ACT syntax.

**Recommendation: retain local Mura TTS.** Live adoption is not justified by the present evidence.
Any future Live or hybrid experiment must remain opt-in, financially bounded, and independently accepted for voice identity.
R7 retains attention authority. R2B retains authorized inference, profile, quota, and spending enforcement.
No subtitle, vision observation, or background task can authorize a model or thinking change.

## N. Limitations, uncertainty, and blockers

- Unknown usage prevents further paid work and final invoice-equivalent cost accounting.
- The controlled matrix has 19 warm attempts per configuration. Its p95 is ineligible.
- Character turns share conversation history. Their empirical quantiles are not independent-sample guarantees.
- Primary repeat coverage is incomplete. Balanced means and the main worksheet exclude unmatched dialogue blocks.
- Secondary levels, detailed scenes, tool finalists, context sizes, direct probes, and the warm top-up remain unrun.
- Human preference, selected-voice similarity, microphone latency, STT, synthesis, playback, interruption, and avatar acceptance remain pending.
- Live availability is metadata visibility, not successful paid session acceptance.
- Numeric thinking-budget ranges for the exact model revisions remain unverified.
- Current prices have a near-term expiry. Reverify pricing before any later campaign.

Do not clear the halted ledger, retry the failed phase, or start another campaign to evade its unknown reservation.
Continuation requires authoritative usage reconciliation and a reviewed mechanism that preserves the original accounting history.
No such record exists locally. More budget alone does not resolve this blocker.

## O. Tests and verification

| Command / check | Result |
| --- | --- |
| `pnpm install --offline --frozen-lockfile --ignore-scripts` | Passed in the isolated worktree |
| Server SDK, server runtime, and audio dependency-closure builds | Passed |
| Simulated preflight before first paid inference | 59 tests passed, zero paid calls |
| Final source-bound preflight | 66 tests passed, zero paid calls |
| Eight focused Companion Core suites | **179 tests passed** |
| `pnpm -F @proj-airi/companion-core typecheck` | Passed using exact raw pnpm |
| `pnpm typecheck` | **56 tasks passed**, after building the missing i18n export |
| Focused benchmark ESLint | Passed |
| `pnpm lint` | Passed, **0 errors and 651 existing warnings** |
| Loopback cancellation, retry delay, and failover fixtures | Passed without provider inference |
| Source `git diff --check` | Passed |
| Evidence `git -c core.whitespace=-blank-at-eof diff --cached --check` | Passed. Generated review files and test logs retain trailing blank lines. |
| Ledger/sample cost equality | 330 settlements match known sample costs. One reservation remains unknown. |
| Independent financial and Live review | Confirms the halt and documentation-only Live decision |

Focused command:

```powershell
pnpm -F @proj-airi/companion-core exec vitest run test/gemini-benchmark.test.ts test/gemini-thinking.test.ts test/gemini-request.test.ts test/gemini-compat.test.ts test/gateway-routing.test.ts test/budgeter.test.ts test/quota-ledger.test.ts test/style-reminder.test.ts --no-file-parallelism --maxWorkers 1
```

The new tests cover capability mismatches, off versus minimal, thinking accounting, $5 admission, remaining-budget rejection, campaign identity, and preserved unknown reservations.
Measurement regressions cover split ACT prefixes, empty voice output, cold classification, context grouping, unknown-cost averages, and balanced blind review.
The original 52-test spending suite remains intact.

RTK incorrectly rewrote typecheck commands and discarded filters. Those results were discarded and rerun raw.
Root lint initially rejected minified phase-marker whitespace. Formatting changed no marker values or timestamps, ledger entries, or sample bytes.
Evidence whitespace verification exempts only blank lines at EOF. Raw test outputs and generated worksheets retain their original endings.
Context Mode page indexing failed because `turndown` was missing. Official web sources provided the fallback.
ccusage records machine-wide Codex totals. Its unpriced-model zero cost is not a zero-spend claim and is separate from the Gemini ledger.

## P. Files, commits, and review identity

Repository: `Aurora-source/airi`.
Exact base: `40669ed3520bc807ece0847591224933e29000af`.
Branch: `codex/gemini-thinking-benchmark-v2`.
Worktree: `D:/AI/airi-gemini-thinking`.

Benchmark source commit: `99c901382e040aae636093c6d4447fab4e5955b1`.
This commit descends directly from the exact requested base.

Source changes are confined to benchmark accounting, receipts, reporting, replay, and the new campaign entry points and tests.
All request evidence is synthetic. No credentials, private conversations, raw thought signatures, or production secrets are included.
The original worktree and Claude's `4186122b3` integration remain separate.

Artifacts:

- [Machine-readable results](gemini-thinking-v2-evidence/results.json) and [comparison CSV](gemini-thinking-v2-evidence/comparison.csv).
- [Immutable request samples](gemini-thinking-v2-evidence/samples.ndjson) and [preserved ledger](gemini-thinking-v2-evidence/ledger.json).
- [Monthly cost forecasts](gemini-thinking-v2-evidence/monthly-costs.json), [thinking capabilities](gemini-thinking-v2-evidence/thinking-capabilities.json), and [verified prices](gemini-thinking-v2-evidence/prices.json).
- Balanced blinded worksheet, separate key, full retained conversations, and voice replay evidence.
- Inactive model overlay, Live metadata, source-linked Live research, and verification logs.
- [Verification manifest](gemini-thinking-v2-evidence/verification.json) records accounting equality, checks, incomplete phases, and evidence hashes.
- [Safe reproduction instructions](../services/companion-core/eval/gemini/thinking-benchmark.md).

The final review SHA is the published branch HEAD, recorded in the completion handoff.
Resolve it with `git rev-parse HEAD` and compare it with `git ls-remote origin refs/heads/codex/gemini-thinking-benchmark-v2`.
No merge or force push is authorized.

## Q. Changes Claude can consider after acceptance

1. Expose explicit trusted Fast, Balanced, and Deep selections through R2B.
2. Bind thinking effort to the resolved model. Validate each fallback separately and reject unsupported combinations.
3. Preserve LOCAL cloud exclusion and current CLOUD/HYBRID authorization and quota semantics.
4. Keep R7 responsible for attention. Prevent external WATCH/NOW content from selecting modes or initiating continuous cloud inference.
5. Retain local Mura TTS. Treat any native Live or transcription hybrid as a separate opt-in architecture.
6. Review leading DELAY markers and unsupported emotions before accepting the fast voice mode.
7. Perform blind human scoring and physical voice acceptance before changing Mura's default.
8. Investigate terminal-usage recovery and the high-thinking deadline before extending this campaign.
9. Revisit the $10–15 monthly plan before 2027 price changes.

No dynamic production switching is implemented. Remaining paid comparisons are blocked, not completed by inference or assumption.
