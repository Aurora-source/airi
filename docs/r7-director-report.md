# R7A Director foundation validation

Branch: `codex/r7-director-foundation`.
Requested base: `4c35d4a048b4f06aa490aad69a7dc68da4c38eb8`.
Worktree: `D:/AI/airi-r7-director`.
Implementation checks and independent review pass. The standalone foundation is ready for delivery.

## Delivered subsystem

The standalone Director owns bounded attention, reaction, gradual mood, independent activity energy, salience, and initiative.
It exposes typed memory, speech, visual, watch, optional reasoning, configuration, and Ops status ports.
It contains no production Stage wiring, media adapter, Jellyfin implementation, animation, or frontend change.
Proactive speech starts disabled. Idle duration never creates an intention or model request.

See [architecture and contracts](ai/adr/2026-10-08-director-foundation.md),
[subsystem usage](../services/companion-core/src/director/README.md), and
[exact future integration instructions](r7-director-integration.md).

## Deterministic validation

The Director suite passes 68 tests in six files.
The complete Companion Core suite passes 777 tests in 47 files, with one existing desktop-helper test skipped.
The full run uses two workers to avoid an existing parallel capture-cancellation timing failure.
The skipped Windows capture test requires `COMPANION_CAPTURE_TEST=1`. The Director tests need no desktop capture or real user media.
Actual R4 SQLite recall, R6 WatchState/ReactionPolicy, and R2B HTTP routing run in the integration tests.
External output ports record structured intentions. No generated speech or animation is claimed as validated.

| Required behavior | Evidence |
| --- | --- |
| 1,000+ consecutive events and storms | 1,500-event mood trace, 5,000-event queue storm, two 100,000-event measurements |
| Repeated observations and duplicate events | Fingerprint and canonical request suppression, repeated screen evidence, duplicate admission |
| Attention transitions and uncertain evidence | Leased conversation, voice, activity, screen, and media state, expiry to unknown |
| Mood continuity and separate energy | Time-gated bounded mood, six-second reaction, separate activity-driven energy |
| User interruption and cancellation | Immediate preemption despite queue saturation, pending and admitted output revocation, owned speech correlation |
| Anime watching | Real R6 dialogue-gap admission and cooldown for silent reactions |
| Subtitle prompt injection | Titles/captions remain untrusted data, no control, model instruction, or tool path |
| Quiet mode, periods, frequency, proactive off | Explicit controls, local time offset, disabled visual frequency, reactive requests preserved |
| Stale observations and dialogue | Capture timestamps, immediate R5 revocation, independent dialogue-gap deadline, conservative uncertain media |
| Memory corrections and provenance | Actual R4 plan recall, item/version support, validity-bound output, invalidated/contested/foreign rejection |
| No invented commitment | Inferred plans, promises, threads, and correction authority rejected |
| Provider failure and model unavailability | Actual CLOUD failure, missing model port, malformed result, quota limit |
| LOCAL/CLOUD/HYBRID semantics | Profile match before transport, gateway-owned quota and explicit fallback |
| Bounded asynchronous failures | One quarantined physical lane per port, 1,000 non-cooperative retry events |
| Bounded input and output processing | Array preflight, bounded memory projection, 16 KiB/1,024-fragment model response |
| Long idle | Twelve hours with proactive enabled, zero speech and zero model attempts |
| Multiple identities | Separate mood, queues, cancellation, and rejection of foreign memory/events |
| Realistic multi-hour session | Eight-hour replay across conversation, work, anime, idle, absence, return, and quiet |

## Synthetic performance measurements

The [machine-readable measurement](r7-director-measurements.json) captures one warmed run on Windows x64 with Node 22.22.2 and exposed GC.
These numbers describe the standalone synthetic policy path. They do not measure model latency, rendering, audio, or the complete AIRI application.
CPU time includes the Node process. Wall time and GC deltas vary with hardware and concurrent work.

| Probe | Events or steps | Wall time | Process CPU | Retained heap delta after GC |
| --- | ---: | ---: | ---: | ---: |
| Consecutive events | 100,000 | 524.2 ms | 547 ms | 86,272 bytes |
| Saturating storm | 100,000 | 354.0 ms | 390 ms | 32,280 bytes |
| Twelve-hour idle | 21,600 advances | 31.1 ms | 32 ms | Not sampled |
| Eight-hour session | 3,849 events | 272.8 ms | 484 ms | Not sampled |

The storm retained 128 queued events before draining and rejected 99,872 excess events.
Both event probes ended with 256 event IDs, 64 decisions, empty queues, and no in-flight work.
The idle probe had zero speech attempts, zero reasoning attempts, and zero timers.
The realistic session produced 25 reactive answers and 24 R6-admitted visual reactions.
It produced zero watch speech, idle speech, absent speech, quiet speech, and model requests.
Its observed peaks were two queued events, 151 IDs, two candidates, 64 history entries, and two Director clock timers.
All Director clock timers were removed on teardown. Tests also shut down the actual R6 policy owner.

Hard caps remain independent of event count: 128 queue entries, 256 IDs, 16 candidates, 128 fingerprints, and 64 decisions.
Recall retains at most eight items, 2,400 combined text bytes, and 16 KiB total metadata.
Non-cooperative output, recall, and model promises retain at most one quarantined lane each.

## Security and privacy decisions

The host authenticates event identity and control authority. The Director is an internal subsystem, not a network authentication boundary.
`configure()` never accepts control extracted from subtitles, webpage metadata, screen text, or memory content.
Ingress projects R5/R6 snapshots before retention and drops titles, dialogue, summaries, frames, and raw audio.
Canonical conversation events carry IDs and flags, without transcript text.
Recall queries stay ephemeral in one bounded request and never enter status or diagnostics.
R4 evidence remains private internal data with provenance. Its generated prompt is ignored.
Status exposes only configuration, enums, confidence, scores, times, counts, and failure categories.
It contains no identity IDs, request IDs, memory text, private queries, or raw backend errors.

Proactive speech needs authenticated user opt-in. Private mode and disable revoke work and clear continuity.
Quiet mode suppresses outward speech and visual reactions. Quiet mode permits actual user record candidates.
Models can request only a visual affect or wait. They cannot speak, persist memory, call tools, or change controls.
The optional adapter calls only an existing loopback reasoning gateway and uses the existing inference credential.
R2B remains the authority for provider routing, profile policy, credentials, quotas, and configured HYBRID fallback.
No new provider infrastructure or database schema is added.

Cancellation combines guard checks, signals, generation invalidation, and evidence deadlines.
Owned voice pulses carry an opaque correlation token. Only the matching live output remains allowed during its own speech.
Expired watch evidence leaves unknown media dialogue until the R6 owner explicitly reports idle or cancelled.
Screen privacy, staleness, or source replacement immediately revokes pending and live screen effects.
Screen semantic keys include locally hashed source identity and generation, without raw source IDs.
R4 support binds actual item versions and validity deadlines, including evidence passed to a speech port.
The watch relay preserves canonical request context and the exact R6 permit, including its earlier deadline.
It reports declined or cancelled output so the future R6 callback cannot record a reaction that did not occur.
External ports must honor cancellation and revalidate guards at the final effect boundary.
R7 cannot stop a hostile injected port from ignoring that contract. Quarantine prevents it from spawning unlimited owned work.

## Reproduction and environment

Dependencies use the unchanged frozen lockfile. Install scripts were disabled during offline setup.
Build existing SDK/runtime dependencies and i18n declarations, then prepare existing extension types when starting from a clean worktree.
These are generated environment artifacts. No project instruction, dependency, lockfile, or production entry point changes are needed.

```powershell
pnpm install --offline --frozen-lockfile --ignore-scripts
pnpm --filter '@proj-airi/server-sdk...' --filter '@proj-airi/server-runtime...' build
pnpm -F @proj-airi/i18n build
pnpm -F @proj-airi/airi-plugin-web-extension exec wxt prepare
pnpm -F @proj-airi/companion-core exec vitest run test/director
pnpm -F @proj-airi/companion-core exec vitest run --maxWorkers=2
pnpm -F @proj-airi/companion-core typecheck
pnpm typecheck
pnpm lint
node --expose-gc --import tsx services/companion-core/eval/director/measure.ts
```

The actual root typecheck passes 56 tasks. RTK's compact typecheck shortcut ran a different check, so validation used raw command replay.
Scoped lint is clean. Root lint passes with zero errors and 651 existing warnings outside this subsystem.
ccusage was checked twice. The second report contains 561,415,708 aggregate recorded tokens across the day.
That total includes other sessions and agents. `gpt-6.1-sol` is unpriced in ccusage, so it cannot establish this task's cost.

## Independent review

A fresh-context read-only reviewer inspected all 28 added files and their owning contracts.
It independently ran all 68 Director tests after the final fixes, with exit code zero.
No Critical, Important, or change-requiring Minor issue remains.

Four reproduced findings were fixed and rechecked:

- Owned speech retains its matching output lease during playback events. Unrelated speech still preempts it.
- Stale or uncertain watch evidence blocks ordinary speech until the R6 owner explicitly stops the session.
- Memory follow-ups and active speech respect actual R4 versions and validity deadlines.
- R5 revocation immediately removes pending screen reactions and cancels active gestures. Capture time bounds their leases.

The review assessed this standalone foundation as ready for delivery.
Production composition, actual voice and animation effects, host authentication, and real cloud availability remain integration responsibilities.

## Future integration acceptance

The R6 owner must expose typed current snapshots and exact live-permit validation during composition.
The accepted Vivid package must be integrated before mapping semantic visual requests to its actual high-level port.
The host must enforce one reply per canonical request, propagate voice activity to both owners, and honor all cancellation leases.
Companion Ops frontend wiring remains a separate change using the exported types.
The later integrated host needs real runtime and UI validation for voice cancellation and visible behavior.
Those production integration tasks remain intentionally outside this foundation branch.
