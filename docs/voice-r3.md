# R3 voice on the integrated branch

R3 voice runs on `integration/r2b-r3`. That branch merges current upstream (`947e26ed8`), accepted R2B (`mura/main`), and R3 (`codex/r3-voice`).

Upstream #2772 moved AIRI voice onto a shared VoiceController pipeline. That pipeline replaced every AIRI file that R3 had patched. The integrated branch uses the upstream pipeline and carries no R3 patch in `apps/` or `packages/`. R3 keeps three parts:

- Companion Core speech recognition: `POST /v1/audio/transcriptions`, the multipart parser, the Groq adapter, and the fallback rules.
- The live harness `packages/testing-audio/scripts/r3-live-voice.ts`.
- The Mura test host `scripts/voice/mura-test-host.py`.

## Configuration

Speech recognition uses the R2B configuration file, providers, keys, and compute profile. Add an alias with the `speech-recognition` role:

```json
{
  "models": {
    "groq-whisper-turbo": { "provider": "groq", "model": "whisper-large-v3-turbo", "capabilities": { "contextWindow": 448, "streaming": false, "tools": false } },
    "groq-whisper": { "provider": "groq", "model": "whisper-large-v3", "capabilities": { "contextWindow": 448, "streaming": false, "tools": false } }
  },
  "aliases": {
    "companion-stt": { "role": "speech-recognition", "chain": ["groq-whisper-turbo", "groq-whisper"] }
  }
}
```

The compute profile limits the speech chain. `cloud` and `cloud-mura-voice` reject a local speech model. `hybrid` accepts a local model only after every cloud model. See [Companion Core audio transcription](../services/companion-core/README.md#audio-transcription) for the fallback rules and bounds.

In AIRI, use the existing OpenAI-compatible providers:

| Module | Base URL | Model and voice |
| --- | --- | --- |
| Hearing | Companion Gateway `/v1/` | `companion-stt` |
| Consciousness | Companion Gateway `/v1/` | `companion-chat` |
| Speech | `http://127.0.0.1:11996/v1/` | `qwen3-tts`, voice `mura` |

Turn on **Auto send** in Hearing. Upstream keeps each voice transcript as a draft by default, so a voice conversation needs auto send.

## Listening and interruption

Upstream's voice store owns one VoiceController per audio host:

- When the microphone is on, a Silero VAD plugin listens continuously.
- Speech onset starts an input that interrupts the session's active responses before transcription starts.
- An interrupted response cancels its speech, its playback, and its chat turn.
- Responses are keyed by turn, so late audio of an old turn cannot play in a new one.
- The default policy allows interruption during playback when the microphone reports echo cancellation. AIRI requests echo cancellation for every microphone.
- Hold to talk sends begin, end, and cancel commands to the same controller.

R3's earlier P2 stop path, recorder patches, and policy store are not needed on this pipeline.

## Reproducing validation

Run these commands from `D:\AI\airi-integration`. The harness reads protected keys without printing them. It never touches the live gateway configuration.

```powershell
pnpm -F @proj-airi/stage-web dev --host 127.0.0.1 --port 5183 --strictPort
python -B scripts/voice/mura-test-host.py --ops-config D:/AI/mura-console/backend/config.py
```

The Mura host starts the existing CrispASR Qwen3-TTS service and its proxy only when no Mura service runs. Type `stop` to stop the processes it started.

```powershell
pnpm exec tsx packages/testing-audio/scripts/r3-live-voice.ts --samples=7
pnpm exec tsx packages/testing-audio/scripts/r3-live-voice.ts --samples=0 --app=http://127.0.0.1:5183/ --turns=20 --gap-seconds=40
pnpm exec tsx packages/testing-audio/scripts/r3-live-voice.ts --samples=0 --app=http://127.0.0.1:5183/ --turns=2 --barge-in --gap-seconds=40
pnpm exec tsx packages/testing-audio/scripts/r3-live-voice.ts --samples=0 --app=http://127.0.0.1:5183/ --push-to-talk --gap-seconds=5
pnpm exec tsx packages/testing-audio/scripts/r3-live-voice.ts --samples=0 --app=http://127.0.0.1:5183/ --stt-error
```

The harness starts an ephemeral gateway from `packages/testing-audio/cases/r3-voice/gateway.r2b.json` with an in-memory state store. Pass `--config=<file>` for another R2B configuration and `--chat-model=<alias>` for another chat alias. The fixture holds key names, never key values.

The microphone is Chromium's file-backed fake device. The harness synthesizes seven public phrases with Windows SAPI, separated by silence, into a temporary file that it deletes at the end. It measures from upstream IO trace spans and VoiceController attempt states:

| Interval | Start | End |
| --- | --- | --- |
| VAD end to STT result | Attempt enters `finalizing` | `Speech recognition` span ends |
| STT result to first text | `Speech recognition` span ends | `llm.first_token` event of the next `LLM inference` span |
| First text to first TTS bytes | `llm.first_token` | First `TTS synthesis` span ends |
| First TTS bytes to playback | First `TTS synthesis` span ends | First `Audio playback` span starts, plus Web Audio output latency |

All intervals start after the 1200 ms VAD silence window. The user hears the reply about 1.2 s later than the total shows. The harness reports metadata only. It never stores audio, transcripts, prompts, or keys.

## Results

Measured on 2026-10-07 and 2026-10-08 on the integrated branch with the Vite dev server, local Mura TTS, and headless Chromium. Percentiles use nearest rank. p95 is withheld below 20 samples. Stage percentiles do not add up to the total percentile.

### Speech recognition through the R2B gateway

Seven categories, one request each: 7 HTTP 200, 6 normalized matches, adapter p50 224 ms. The punctuation phrase kept its punctuation, but the AIRI name was spelled differently. The Japanese greeting matched. This verifies one greeting, not broad Japanese accuracy. No WER is claimed.

### End-to-end latency

The chat alias was `companion-chat`, the provisional R2B chain. Gemini 3.1 Flash-Lite served almost every turn.

| Run | Turns | VAD end → STT | STT → first text | First text → TTS | TTS → playback | Total p50 | Total p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 20 | 509 | 9498 | 1411 | 362 | 12523 | 19672 |
| C | 8 | 618 | 2366 | 1018 | 366 | 4294 | n/a |
| D | 20 | 587 | 14622 | 942 | 360 | 16557 | 28479 |
| Old R3 (R2A path, Gemini 3.5 Flash-Lite) | 21 | 674 | 2261 | 1249 | 123 | 4286 | 5328 |

All values are p50 in milliseconds unless the column says otherwise. Run D also split the chat interval: AIRI's work from the STT result to the chat request took p50 635 ms, and the gateway saw the provider's first byte at p50 14440 ms.

The provider's time to first token decides the total. The same model gave a 1.2 s first byte for one tiny prompt and 19.6 s for the next. Gemini 3.5 Flash-Lite and Gemini 3 Flash Preview returned daily-quota 429 errors during the runs, so the faster model could not be measured. `reasoning_effort` showed no consistent effect. The 2.5 s p50 target is not met.

### Interruption, hold to talk, and errors

| Check | Result |
| --- | --- |
| Interrupt while the reply is generating | Playback silent, chat turn closed, gateway logged the provider stream as cancelled |
| Interrupt 500 ms after audible output | Silent after 5 ms in software |
| Interrupt during a later chunk | Silent after 201 ms in software, including the fade |
| Next turns after interruptions | 5 committed, 4 reached playback |
| Hold to talk, cancelled hold | Cancelled, no turn |
| Hold to talk, normal hold after that | Committed |
| Hold to talk, immediate release | Committed. Whisper can return text for a very short clip, so check it by hand. |
| Injected STT 429 | Error text visible, zero chat and TTS requests |

These are software timings. They do not measure the sound that leaves your headphones.

## Manual acceptance checklist

Use the intended headphones, avatar, and Mura voice. Turn on the microphone and Hearing auto send. No item counts as passed until you confirm it.

1. Speak short and long English sentences, quietly, slowly, and with background noise. Each utterance makes one user turn with useful punctuation.
2. Set Hearing to Japanese and say a Japanese sentence. Check the transcript, then restore your language.
3. Ask for a multi-sentence answer. Check that it is the Mura voice, that the first chunk starts promptly, and that chunks play in order without overlap.
4. Watch the mouth move with speech and stop when speech stops.
5. Watch the ACT emotion and motion change on the avatar. No ACT or reasoning marker is spoken or shown.
6. Interrupt about 500 ms after audible speech begins. The voice stops, and your new utterance becomes one turn.
7. Interrupt during a later chunk of a long answer. Old chunks never resume.
8. After each interruption, speak a new sentence. It gets a normal spoken answer.
9. Measure physical sound-stop latency with a loopback recording or a video, from your speech onset to silence. The target is about 300 ms.
10. Interrupt while the reply text is still streaming. The chat turn stops, and no late text or audio of that turn appears.
11. Speak while AIRI is idle. Nothing stops, and the turn appears once.
12. Hold to talk: hold and release, then release immediately, then lose window focus while holding. A discarded hold makes no turn, and the next hold works.
