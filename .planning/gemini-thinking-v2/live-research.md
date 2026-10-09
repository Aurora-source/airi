# Gemini 3.8 Live research and financial review

Research date: 2026-10-09. Sources are current official Google documentation. Context7 resolution and queries preceded direct documentation reads.

**Decision: NO-GO for paid Live tests in this campaign.** Documentation and authorized API metadata remain the available evidence.
This review made zero API generation calls and read no credentials.
It changed no production setting. It made no microphone, playback, physical interruption, or audio-quality measurement.

The V2 total ceiling remains $5, including all prior V2 requests and unresolved exposure.
Live can use at most $1 of the remaining allowance. That allocation is part of $5, not an additional budget.

## Current model contract

| Model | Reasoning control | Completion and tools |
| --- | --- | --- |
| `gemini-3.8-live` | Interleaved reasoning. Omit `thinking_level` and `thinking_config`. | `turnComplete` returns the model to idle. Async tools default to `NON_BLOCKING`. Explicit `BLOCKING` remains supported. |
| `gemini-3.8-live-extended-thinking` | `thinkingConfig.thinkingLevel` accepts `LOW`, `MEDIUM`, or `HIGH`. SDK examples use lowercase values. `MINIMAL` is unsupported. | An utterance can finish while background work continues. Wait for `interaction_status: IDLE`. Functions require `NON_BLOCKING`. |

Both stable models accept text, images, audio, and video. Each lists 131,072 input tokens and 65,536 output tokens.
Both permanently enable proactive audio. A false `proactive_audio` value returns an error.
Function calls and Google Search grounding are supported. Structured outputs, caching, code execution, file search, and URL context are unsupported.
Sources: [standard model](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live), [Extended Thinking model](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live-extended-thinking).

For Extended Thinking, `turnComplete: true` can accompany `interactionStatus: IN_PROGRESS` after spoken filler.
The model can then request tools and speak again before `IDLE`.
`LOW` describes reasoning depth. The guide does not establish a numerical cap for aggregate reasoning across that interaction.
Source: [Thinking lifecycle](https://ai.google.dev/gemini-api/docs/live-api/thinking).

## Native protocol, media, and interruption

The API reference documents `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`.
The Thinking guide instead shows the `v1alpha` version. These are native WebSocket APIs, separate from OpenAI chat completions.
The initial `setup` selects `models/{model}`, `generationConfig`, `systemInstruction`, and tools.
`generationConfig.maxOutputTokens` exists in the reference. Its presence does not establish a ceiling for an entire session or multi-utterance interaction.
Sources: [WebSocket reference](https://ai.google.dev/api/live), [Thinking setup](https://ai.google.dev/gemini-api/docs/live-api/thinking).

Audio uses raw 16-bit little-endian PCM. Native input is 16 kHz, with resampling available. Output is 24 kHz.
Input audio uses `realtimeInput.audio` with `audio/pcm;rate=16000`.
Output chunks use `serverContent.modelTurn.parts[].inlineData` with `audio/pcm;rate=24000`.
Video uses individual JPEG or PNG frames, at most one frame per second.
Native audio models require `responseModalities: [AUDIO]`. Text comes from `outputAudioTranscription`, not a text-only Live response.
Source: [Live capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities).

The Developer API guide describes audio tokenization as approximately 25 tokens per second of audio.
Google Cloud's Live session guide gives 25 audio tokens/second and 258 video tokens/second.
These describe media duration. They do not limit tokens generated per second of wall-clock time.
Sources: [Developer API practices](https://ai.google.dev/gemini-api/docs/live-api/best-practices), [Cloud session guide](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/start-manage-session).

VAD interrupts active generation. On `serverContent.interrupted`, the client must stop playback and clear its audio queue.
The reference also defines `toolCallCancellation.ids`. Client tools need cancellation and stale-result isolation by call ID and interaction.
Sources: [Live capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities), [WebSocket reference](https://ai.google.dev/api/live).

Without compression, audio sessions last at most 15 minutes. Audio/video sessions last at most two minutes.
Connections last approximately ten minutes. Compression and session resumption can extend the overall session indefinitely.
Those limits do not provide a financial session cap.
Source: [session management](https://ai.google.dev/gemini-api/docs/live-api/session-management).

## Prices and accounting evidence

Both requested models share these paid Standard prices, in USD per million tokens.

| Billable category | Price | Published minute estimate |
| --- | ---: | ---: |
| Text input | $0.75 | — |
| Audio input | $3.00 | $0.005/min |
| Image/video input | $1.00 | $0.002/min |
| Text output, including thinking | $4.50 | — |
| Audio output | $12.00 | $0.018/min |

Google Search shares 5,000 free monthly requests across Gemini 3.x, then costs $14 per 1,000 individual queries.
The free allocation cannot be assumed available. Paid tests need Search disabled or a separately proven bound.
Source: [current pricing](https://ai.google.dev/gemini-api/docs/pricing).

History remains native audio and is billed again at the audio input rate on subsequent turns.
Both input and output transcription generate additional text charges at the text output rate.
The minute estimates therefore do not bound a session with history, thinking, transcription, or tools.
Source: [billing practices](https://ai.google.dev/gemini-api/docs/live-api/best-practices).

The capabilities example states: “The server will periodically send messages that include UsageMetadata.”
It does not guarantee a final cumulative session record on close, interruption, timeout, or network failure.
Source: [usage example](https://ai.google.dev/gemini-api/docs/live-api/capabilities#token-count).

Relevant native fields are `usageMetadata.promptTokenCount`, `responseTokenCount`, `thoughtsTokenCount`, `totalTokenCount`, and `toolUsePromptTokenCount`.
Modality detail uses `promptTokensDetails`, `responseTokensDetails`, and `toolUsePromptTokensDetails`.
The reference describes `totalTokenCount` for a generation request. It does not define an authoritative cumulative billing total for the session.
Source: [UsageMetadata reference](https://ai.google.dev/api/live#UsageMetadata).

There is also a status-shape discrepancy.
The reference places `interactionStatus` under `serverContent`. Thinking SDK examples read a top-level field, and some wire examples use both locations.
A future adapter needs a pinned protocol contract before paid use. Neither `IDLE` nor socket closure certifies final monetary usage.
Sources: [server messages](https://ai.google.dev/api/live#BidiGenerateContentServerContent), [Thinking examples](https://ai.google.dev/gemini-api/docs/live-api/thinking).

## Existing guard review

The worktree has no `.codegraph` directory. This review used targeted source reads.

| Existing source | Finding |
| --- | --- |
| `services/companion-core/eval/gemini/accounting.ts:7` | `Price` excludes audio and paid server tools. `Usage` has one output price and no modality breakdown. |
| `accounting.ts:65` | `parseUsage` accepts OpenAI usage fields. Native Live fields need a different contract. |
| `accounting.ts:109` | The durable lock, atomic persistence, preserved reservations, and unknown-usage halt remain useful. |
| `accounting.ts:160` | Reservations cover one input/output pair. There is no Live suballocation or aggregate session reservation. |
| `protocol.ts:17` | Discovery filters for `generateContent`. It does not establish `bidiGenerateContent` availability. |
| `protocol.ts:91` | `StreamMeter` expects SSE, `[DONE]`, and terminal usage. It cannot consume native WebSocket lifecycle events. |
| `runner.ts:88` | The runner uses bounded OpenAI chat requests. Its timeout does not implement native session shutdown or background-work reconciliation. |

The global $5 ledger cannot enforce the separate $1 Live allocation without another admission constraint.
A new independent ledger does not preserve the campaign's shared exposure.

Inference: reserving the published full capacities at the highest input/output modality prices costs $1.179648 for one generation.
The calculation is `131072 × $3/1M + 65536 × $12/1M`.
That illustrative reservation already exceeds $1. It still does not bound multiple background utterances or later context reprocessing.
Reducing it requires a proven aggregate output/thinking limit and a finite generation count.

Paid Live tests fail these gates:

1. No guaranteed terminal usage or documented session-cumulative billing semantics.
2. No proven aggregate bound for Extended Thinking's reasoning, fillers, and repeated outputs.
3. No modality-aware accounting or native session meter in the existing harness.
4. No implementation that stops transport, input, background tools, and playback while preserving unresolved monetary exposure.
5. No current campaign guard that jointly enforces the total ceiling and Live suballocation.

An automatic wall-clock stop is necessary for a future experiment. It cannot replace those missing bounds or terminal accounting guarantees.
Unknown usage must retain the full reservation and stop all subsequent paid dispatch. Reconnect and retry must remain disabled for the experiment.

## Languages, persona, and Mura voice

English and Japanese are listed supported languages. Native audio selects the language automatically.
System instructions can constrain language, personality, tone, and conversational rules.
That support is not measured Japanese accuracy or Mura persona fidelity.
Sources: [supported languages](https://ai.google.dev/gemini-api/docs/live-api/capabilities#supported-languages), [persona instructions](https://ai.google.dev/gemini-api/docs/live-api/best-practices#design-clear-system-instructions).

The Developer API documents prebuilt voices through `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`.
That contract does not establish portability of local Mura TTS or Gemini Voices IDs into Live.
Source: [voice configuration](https://ai.google.dev/gemini-api/docs/live-api/capabilities#change-voice-and-language).

Google Cloud documents custom Live voice replication for selected customers, with access through the Cloud account team.
It requires rights and consent, plus a 10–20 second PCM `s16le` sample.
The setup uses `replicated_voice_config.voice_sample_audio` and `mime_type`.
This separate Cloud feature does not establish access for the existing Developer API credential or Extended Thinking model.
Source: [Cloud custom voice](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/configure-language-voice#use_a_custom_voice).

## Inactive architecture options

The existing route remains Groq STT → R2B-authorized Flash text → local Mura TTS.
It preserves the local voice and existing ACT, text, interruption, and gateway behavior described in `docs/voice-r3.md`.

An opt-in native Live route sends audio directly to Google and receives Google's generated audio.
It needs a separate native gateway boundary, lifecycle controller, audio queue, tool policy, and financial contract.
The generated voice cannot silently replace local Mura TTS.

An opt-in hybrid route can discard Live audio and send its output transcription to local Mura TTS.
Live still generates billable audio, and transcription adds cost. That route adds synthesis latency and needs shared cancellation ownership.
It does not establish the latency benefit of direct Live playback.

R7 retains attention authority. R2B retains inference authorization, model choice, and thinking policy.
WATCH and NOW observations cannot select a model or thinking level.
These are proposals only. No production switch or paid Live result follows from this review.
