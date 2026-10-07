# R3 voice implementation

R3 runs in `D:\AI\airi-r3` on `codex/r3-voice`, based on accepted R2A
`ed5d2b8831dbe14b4b87568fc48508b0ca2d97a2`. It must wait for completed R2B
before rebasing or merging. The active R2B and archived worktrees were not edited.

## Configuration

Create `companion-audio.json` beside the existing Companion Core configuration:

```json
{ "profile": "cloud-mura" }
```

An absent audio configuration leaves STT disabled. See
[Companion Core audio configuration](../services/companion-core/README.md#audio-transcription)
for bounds, credentials, and explicit LOCAL/HYBRID targets.

| Profile | STT | Local STT fallback |
| --- | --- | --- |
| CLOUD / cloud-mura | Groq Whisper turbo, then large when unavailable | Rejected |
| HYBRID | Groq first | Only an explicitly configured loopback target |
| LOCAL | Explicit loopback Whisper-compatible server | No cloud request |

Companion Core never starts a local STT process. Cloud 429 responses remain visible;
they do not switch to a second cloud model. HYBRID can explicitly route eligible
cloud failures to its local target within the original request deadline.

In AIRI, use the existing OpenAI-compatible providers:

| Module | Base URL | Model / voice |
| --- | --- | --- |
| Hearing | Companion Gateway `/v1/` | `companion-stt` |
| Consciousness | Companion Gateway `/v1/` | `companion-chat` |
| Speech | `http://127.0.0.1:11996/v1/` | `qwen3-tts`, voice `mura` |

The Gateway inference token stays in AIRI's existing provider settings. Groq and
Gemini credentials stay in Companion Core. R3 does not proxy or replace Mura TTS.
The existing AIRI speech sessions, chunking, ACT parsing, playback, and lip sync remain in use.

## Listening and interruption

The user's selected default is headphones with continuous listening. Policies use
`settings/voice-input/mode` (`continuous`, `wake-word`, `push-to-talk`) and
`settings/voice-input/output-device` (`headphones`, `speakers`). These are string
settings. Reload after changing them directly in local storage.

Headphones allow continuous VAD while AIRI speaks. Detected speech publishes
the existing stop-speaking action with reason `user-speech`. The Stage consumes it
synchronously, cancels its speech session and queued playback, resets speaking/lip
state, and cancels the identified chat generation. Late events from that response
cannot feed a replacement speech session.

Speakers retain assistant echo suppression. Wake-word policy disables automatic
capture; a wake-word detector belongs to a later phase. Batch providers have a
Hold to talk control in Stage web. Hold the pointer or Space; release sends one
recording. Focus loss and pointer cancellation discard it. Native AIRI retains its
existing explicit recorder controls. Streaming providers retain their existing
microphone control; the listening mode selector remains available when switching providers.

An independent interactive-area streaming consumer is outside the measured batch
Groq path. It does not yet share every speaker-policy suppression hook. Mobile
composer auto-send and streaming TTS do not yet provide complete latency correlation.

## Reproducing validation

Run these commands from the isolated worktree. Existing protected credentials are
read without printing them. Do not configure or restart the active R2B Gateway.

```powershell
rtk proxy pnpm -F @proj-airi/stage-web dev --host 127.0.0.1 --port 5183
rtk proxy python -B scripts/voice/mura-test-host.py --ops-config D:/AI/mura-console/backend/config.py
```

The optional Mura host starts only the existing CrispASR Qwen3-TTS service and
proxy. Enter `stop` in its terminal to stop the processes it owns. It leaves an
already-running Mura service alone.

```powershell
rtk proxy pnpm exec tsx packages/testing-audio/scripts/r3-live-voice.ts --config=packages/testing-audio/cases/r3-voice/gateway.r2a.json --samples=7
rtk proxy pnpm exec tsx packages/testing-audio/scripts/r3-live-voice.ts --config=packages/testing-audio/cases/r3-voice/gateway.r2a.json --samples=50
rtk proxy pnpm exec tsx packages/testing-audio/scripts/r3-live-voice.ts --config=packages/testing-audio/cases/r3-voice/gateway.r2a.json --samples=0 --capture-ms=450000 --min-completed=20 --app=http://127.0.0.1:5183/
rtk proxy pnpm exec tsx packages/testing-audio/scripts/r3-live-voice.ts --config=packages/testing-audio/cases/r3-voice/gateway.r2a.json --samples=0 --capture-ms=50000 --min-completed=2 --barge-in --app=http://127.0.0.1:5183/
rtk proxy pnpm exec tsx packages/testing-audio/scripts/r3-live-voice.ts --config=packages/testing-audio/cases/r3-voice/gateway.r2a.json --samples=0 --capture-ms=15000 --push-to-talk --app=http://127.0.0.1:5183/
rtk proxy pnpm exec tsx packages/testing-audio/scripts/r3-live-voice.ts --config=packages/testing-audio/cases/r3-voice/gateway.r2a.json --samples=0 --stt-error --app=http://127.0.0.1:5183/
```

The harness creates an ephemeral authenticated Gateway and browser context. It
can use an explicit R2A-compatible fixture because R2B may change the shared runtime
schema. The fixture references protected keys and never contains their values.
The harness
uses Chromium's native file-backed microphone, AIRI VAD/recording, cloud STT/chat,
the real local Mura service, and AIRI playback. It records timestamps and request
counts without audio, transcript, prompt, or credentials. Corpus phrases are
synthesized in memory. The Japanese greeting is Spesco's unchanged
[CC BY-SA 4.0 sample](https://commons.wikimedia.org/wiki/File:Ja-konnichiwa.ogg), fetched into memory.

The `--barge-in` check injects a speech-start signal 500 ms after observed playback
and exercises the mounted Stage's stop/generation ownership path. The ordinary
21-turn run also observed a real VAD interruption and subsequent recovery.
`--stt-error` injects a provider 429 to verify the real error toast and absence of
downstream chat/TTS. Captures with too few completed responses fail. Corpus
word matching is an observation, not a WER or an automatic accuracy acceptance gate.

## Observed STT probe

The paced 50-request probe completed with 50 HTTP-200 responses. Adapter-only
latency was p50 263 ms / p95 413 ms. This repeated seven test categories; it is
not a diverse 50-utterance accuracy benchmark and no WER is claimed.

| Category | Requests | Normalized reference matches |
| --- | ---: | ---: |
| English short | 8 | 8 |
| English longer | 7 | 7 |
| Punctuation / AIRI proper name | 7 | 0 |
| Quiet | 7 | 7 |
| Slow | 7 | 7 |
| Added background noise | 7 | 7 |
| Japanese greeting | 7 | 7 |

All seven punctuation samples contained punctuation, but the AIRI proper name
differed from the strict reference. The Japanese result verifies this greeting,
not broader Japanese or system-audio accuracy. An earlier rapid 50-request probe
received 22 provider 429s; error propagation and explicit fallback restrictions
also have automated coverage. A paced attempt stopped after 34 successes before
the final retry; its preparation failure was not attributed to the STT provider.

## Observed latency

The 21-turn run repeated one upstream English fixture with conversation history
growing normally. A single VAD interruption occurred. Background validation jobs
ran during part of the capture. These are useful local measurements, not a
representative human speech benchmark.

| Interval | Samples | p50 ms | p95 ms |
| --- | ---: | ---: | ---: |
| VAD end → STT result | 21 | 674 | 854 |
| STT result → first LLM text delta | 21 | 2261 | 2641 |
| First LLM text delta → first TTS bytes | 21 | 1249 | 1525 |
| First TTS bytes → Web Audio start | 21 | 123 | 723 |
| VAD end → estimated audible output | 21 | 4286 | 5328 |

The total adds Web Audio's reported base/output latency to the actual source
start. It does not measure physical headphone output. Percentiles use nearest
rank, and p95 is withheld below 20 samples. Per-stage percentiles do not add up
to the percentile of the total.

The 2.5-second p50 target was not met. Chat and TTS were the largest intervals.
R3 does not change R2B's provider routing or prompt budgets to improve this result.
The mounted Stage signal-to-stop tests measured 0.3–0.8 ms; physical stop latency
still requires the manual check below. Later functional checks running alongside
other validation took approximately 12–14 seconds for a complete response. Those
small runs verify recovery and do not replace the 21-turn latency measurement.

## R2B integration point

Audio implementation is isolated under Companion Core `src/audio/` and
`providers/groq-transcription.ts`. Shared edits are:

- `services/companion-core/src/server.ts`: audio options, alias discovery, route registration.
- `services/companion-core/src/bin/run.ts`: separate audio configuration and protected key loading.
- `services/companion-core/README.md`: audio setup documentation.
- Stage web/native pages: speech-start stop action, listening policy, transcription/turn correlation.
- `Stage.vue`: response ownership guards, cancellation, and TTS/playback timing.
- `stores/chat.ts`: one first-text-delta timing hook.
- Hearing consumers: speech-start event propagation.
- Audio recorder: snapshot finalization hooks so old audio cannot move to a replacement binding;
  cancel discarded recordings without finalizing an empty WAV.

R2B may replace the audio profile adapter/configuration boundary. Keep CLOUD's
local-fallback prohibition and HYBRID's explicit opt-in. No provider-chain,
quota, sticky-routing, prompt-budget, persona, MCP, or Watch Together feature was changed.

## Manual acceptance checklist

Use the intended headphones, avatar, and Mura voice. Enable microphone access and
verify Hearing/Consciousness/Speech selections above. Check the following:

1. Say a short and long English sentence, speak quietly and slowly, and repeat with realistic background noise. Confirm one user turn per utterance and useful punctuation.
2. Select Japanese language in Hearing and speak a Japanese sentence. Confirm the transcription and restore your usual language afterward.
3. Have AIRI give a multi-sentence answer. Confirm Mura identity, prompt first chunk, ordered non-overlapping chunks, lip movement, and appropriate ACT/emotion behavior. ACT/reasoning markers must not be spoken.
4. Interrupt during playback, including 500 ms after it begins. Repeat three times and during a later chunk. Measure detected speech to actual sound stopping with audio loopback/video if available; target approximately 300 ms.
5. After each interruption, say a new sentence. Confirm current/queued old speech stays stopped, the new turn appears once, and its answer plays normally. Also speak while idle and verify no spurious stop or duplicate turn.
6. Use Hold to talk: pointer hold/release, Space hold/release, Space followed by Tab, and window focus loss. Focus loss must discard the recording; the next normal hold must still work.
7. Verify the visible STT error with the harness's 429 check. CLOUD must never start or call local STT; HYBRID fallback requires an explicitly configured, already-running local STT service.
8. Confirm provider cancellation in Gateway metadata for an interruption while cloud generation is still active. Automated playback-stop checks do not prove that every live request is still active when interrupted.
9. Repeat the latency run with real microphone and headphone loopback before accepting the physical end-to-end latency target.

No claim is made that Mura sounds correct or that the avatar's emotion looks correct
without these human checks.
