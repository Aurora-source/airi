# R6 Watch Together foundation

Base: `36d0e990474d9d0931476fc455073dc57e609e2a` (`codex/r5-perception`).
Branch: `codex/r6-watch`. Worktree: `D:\AI\airi-r6`.
Current upstream main inspected: `45b8670e63f93debe7000453832b0611a66a5129`.

## Result

R6 provides an isolated WatchState boundary, browser lane normalization, current dialogue tracking and deterministic reaction admission.
It consumes fresh R5 hints and optional metadata without changing runtime assembly.
Optional system-output STT uses existing speech-recognition aliases. It never records continuously.
English and Japanese paths preserve language and Unicode dialogue.
AniList identity metadata is optional. Spoiler-sensitive context requires explicit completed progress and verified episode bounds.
WatchEventPort exposes selected memory candidates. R4 persistence remains separate.

## Source evidence

CodeGraph inspected upstream extension types, content observers and background lane producers.
The inspected producer source matches the R5 base.
Upstream supplies title, identity, playing state, position, playback rate and subtitles for YouTube and Bilibili.
The R6 normalizer imports the owning upstream payload contracts.
Structured browser evidence takes priority over subtitle title hints, visual guesses and system-audio inference.
A visual frame never establishes playing state or episode identity.

## State and timing

Browser stamps contain session, sequence, acquisition time and playback epoch.
R6 rejects prior sessions, older sequences, expired observations, future timestamps and superseded timelines.
Seeks, navigation and episode changes invalidate dialogue, scene evidence and asynchronous work.
Snapshots apply TTL and detach returned evidence from the owned state.
Only one current bounded caption and scene exist. No subtitle history, raw frame or audio storage exists.
Untimed caption expiry leaves dialogue activity unknown.
Timed cue ends and fresh VAD establish bounded silence. Active or unknown dialogue suppresses reactions.
Reaction admission waits for at least 1.5 seconds of proven silence and defaults to a three-minute cooldown.
Repeated fingerprints are suppressed. User speech revokes pending audio and reaction permits.

## Spoiler boundary

The AniList query requests confirmed identity titles, episode count and duration only.
It never requests general plot descriptions, characters, relationships, tags, reviews or future episode data.
The public API cannot establish episode safety for synopsis or character data. Those fields remain withheld.
Separately trusted, curator-verified context passes only within explicit completed progress for the same show.
Unknown progress withholds every spoiler-sensitive entry.
A guessed current episode, seek position or visual title never becomes completed progress.

## Integration seams

Detailed local notes: `D:\AI\.planning\r6-watch-codex\integration_notes.md`.

| Consumer | Required seam |
| --- | --- |
| Integrated runtime | Import the `@proj-airi/companion-core/watch` subpath after acceptance. Inject clock, transport and lifecycle owners. |
| Browser extension | Authenticate lane producers. Preserve acquisition time. Allocate session, sequence and playback epoch before asynchronous work. |
| R5 perception | Pass PerceptionService.current() through FreshPerceptionPort. Correlate capture target with selected media. |
| STT | Inject authorized bounded system-output capture. GatewaySpeechRecognition calls existing R3 `/v1/audio/transcriptions`. |
| R3 voice | Preserve headphones, wake-word, speakers and push-to-talk behavior. Honor reaction signals before and during output. |
| R4 memory | Subscribe to selected WatchEventPort events. Choose persistence and privacy later. No direct R4 import exists. |
| R7 Director | Supply salient candidates through deterministic admission. No Director or autonomous cognition is implemented. |

Upstream currently omits producer timestamps, sequence numbers, seek events and DOM-caption clear events.
Receiver stamps alone cannot establish ordering across an unknown upstream queue.
Preserving producer timestamps and epochs needs a small upstream contract change during integration.
R6 detects observed position jumps. An unreported seek remains unknown until the next upstream update.
No extension scraping capability is rebuilt.
No runtime-hot file, R5 internal module or other worktree is changed.

## Validation

Final full Companion Core run: 521 tests pass in 30 files, including 64 R6 tests.
Affected typecheck and root `pnpm typecheck` pass.
Targeted ESLint passes. Root `pnpm lint` exits successfully with zero errors and 679 existing ESLint warnings.
The broad fast-lint phase reports 11 existing warnings and zero errors.
`git diff --cached --check` passes.
The independent reviewer confirmed all Important findings fixed. No Critical or Important issue remains from that review.

Review regressions cover delayed pre-resume silence and repeated VAD gap refresh.
They cover expired playback implying silence, permit expiry beyond evidence and audio acquired before demand.
Each issue was reproduced before its fix. All regression tests pass.

| Command | Result |
| --- | --- |
| `pnpm -F @proj-airi/companion-core test` | 521 tests pass. |
| `pnpm -F @proj-airi/companion-core typecheck` | Pass. |
| `pnpm typecheck` | Pass across the root workspace graph. |
| `pnpm exec eslint services/companion-core/src/watch services/companion-core/test/watch services/companion-core/eval/watch` | Pass without findings. |
| `pnpm lint` | Exit 0. Zero errors. Existing warnings remain outside R6. |
| `node services/companion-core/eval/watch/live-browser.mjs <generated-artifact-directory>` | Synthetic runtime checks pass. Live YouTube player unavailable. |

The deterministic tests cover play, pause, seek, video/episode changes and subtitle progression.
They cover duplicate/missing captions, stale visuals, conflicting titles and delayed/out-of-order events.
They cover English/Japanese audio fallback, gaps, dialogue suppression, cooldown, user interruption and cancellation.
They cover spoiler boundaries, unknown progress, browser reconnect, buffer erasure and privacy blocking.

Chromium `151.0.7922.34` validated upstream content observers against a generated subtitle-heavy video.
English and Japanese captions progressed. Timed gaps, play/pause/resume/seek and session disconnect/reconnect checks passed.
The probe substitutes the extension transport with the isolated watch bridge. It does not validate a deployed WebSocket integration.
The generated WebM and build artifacts remain outside Git. The replay probe is `eval/watch/live-browser.mjs`.
The live YouTube player was unavailable in the validation browser. No live YouTube pass is claimed.
Playwright MCP could not start its configured Chrome executable. The installed Chromium ran through Playwright directly.
No gateway was running on port 11980. Live system-output STT was unavailable.
The speech-recognition capability adapter and English/Japanese fallback paths are covered by deterministic boundary tests.
Live AniList identity lookup succeeded and returned three title variants without plot or character fields.

## Acceptance evidence

| Requirement | Evidence |
| --- | --- |
| Normalized browser state | Existing payload contracts, lane parser and YouTube/Bilibili identity tests. |
| Current subtitles/dialogue | Progression, duplicates, cue gaps, Japanese and missing-caption tests. |
| Fresh R5 fusion | Fresh-only boundary, title conflict, stale frame and privacy tests. |
| Conditional system audio | Missing/incomplete/protected-video admission, available-caption suppression and bounded request tests. |
| English/Japanese | Both recognition language paths and real Chromium Japanese captions. |
| Dialogue-aware suppression | Active/unknown dialogue rejection and proven-gap admission. |
| Sparse reactions | Cooldown, repeat suppression, user interruption and evidence-bound cancellation. |
| Hard spoiler boundary | Unknown-progress withholding, matching show identity and future-entry exclusion. |
| Temporal integrity | Session, sequence, timeline, acquisition-time, revision and TTL regressions. |
| Ephemeral media | No raw media persistence or logger. Buffer erasure and detached snapshot tests. |
| Future R4 events | Selected event-port tests. Captions never emit memory candidates. |
| Tests/typechecks | 521 tests and affected/root typechecks pass. |

The foundation is ready for integration. Runtime wiring and R7 remain separate work.

## Privacy and persistence

Production watch modules have no logger, filesystem writer or database handle.
Audio buffers are erased after recognition and on late cancelled captures.
Perception blocking clears visual hints and suppresses audio. Safe browser metadata and captions remain usable.
Memory candidates contain bounded identity and selected user opinion or shared reaction only.
Caption lines and routine scene observations never emit memory events.
All media text remains untrusted data. Future runtime context must retain that boundary.
