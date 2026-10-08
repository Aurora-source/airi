# Watch Together foundation

The isolated R6 subsystem tracks current media and admits sparse reactions during proven dialogue gaps.
It consumes upstream extension lanes, fresh R5 hints and optional metadata.
It captures no screen frames and runs no continuous audio recorder.

## Public boundary

Import `@proj-airi/companion-core/watch`.

- `normalizeBrowserLane`, `normalizeVideo` and `normalizeSubtitle` normalize existing upstream contracts.
- `WatchState` owns current identity, playback, dialogue, scene evidence, timestamps, confidence and expiry.
- `ReactionPolicy` waits for dialogue gaps, enforces cooldown and cancels on user interruption.
- `SystemAudioFallback` admits bounded, authorized requests when dialogue context is missing.
- `GatewaySpeechRecognition` uses the existing R3 speech-recognition alias and gateway route.
- `AniListAdapter` fetches optional identity metadata without requesting plot or future characters.
- `contextWithinProgress` filters separately verified context against explicit completed progress.
- `WatchEventPort` exposes selected future memory candidates without persisting them.
- `MediaSourceManager` groups the players of all sources into one playback, selects one, and restamps one ordered stream.
- `MediaSourceAdapter`, `PlayerObservation`, and `CueRequest` (`sources.ts`) are the contract for player sources.
- `mediaTitleOf` reads show, season, and episode from player titles and anime release file names.
- `assLinesOf`, `dialogueOf`, `subtitleTextOf`, and `languageCodeOf` normalize current subtitle text.

## Temporal and privacy rules

Use one selected source per instance. The host authenticates producers and supplies ordering stamps.
Session, sequence, playback epoch, revision and acquisition timestamps prevent stale replacement.
Snapshots apply TTL on every read and return detached current objects.
Untimed caption expiry means unknown dialogue activity. Timed cue ends and fresh VAD evidence establish bounded gaps.
A visual frame proves neither playback nor episode identity.
All media text is untrusted data. It cannot grant tools or become instructions.
No logger, filesystem writer, memory database, raw frame or subtitle history exists in this subsystem.
Raw system-output buffers are erased after recognition and after cancelled late captures.
If R5 blocks perception, safe browser metadata and subtitles still work.

## Runtime integration

`src/companion/watch.ts` is the host in the Companion Core. It joins AIRI's server channel and owns one WatchState per selected group.
`src/companion/watch-bridge.ts` checks the extension stamp, sessions, and stream selection.
`src/companion/sources` holds the mpv, VLC, and Jellyfin adapters. They report to the source manager only.
The Core README section Watch Together lists its behavior, tools, and Ops routes.

## Host responsibilities

The host supplies system-output capture, permission signals, fresh perception, extension transport and output cancellation.
The host preserves headphones, speakers, wake-word and push-to-talk policy from R3.
Before voice output, revalidate each reaction permit and honor its signal during speech.
Permits automatically cancel when their supporting playback, media or silence evidence expires.
System-output segments must start after the demand. Cached audio from earlier media is rejected.
Call `finish` when speech settles. Shut down audio and reaction owners when the watch session ends.
Spoiler-sensitive external context requires matching show identity and verified episode bounds.
General AniList synopsis and characters remain withheld because the public API cannot establish episode safety.

## Checks

Run `pnpm -F @proj-airi/companion-core test` and the affected workspace typecheck.
The watch tests use deterministic clocks and synthetic English/Japanese dialogue.
The optional live browser probe uses upstream content observers and generated video outside Git.
No copyrighted media fixture is required.
