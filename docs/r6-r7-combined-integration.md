# R6 local media, Vivid visual presence, and R7 Director: combined runtime

Branch: `integration/r6-media-visual-r7`. Base: `feature/r6-local-media` `4eabf3daa`.
This document describes the integrated runtime, its owners, its channel events, and the Core API that Companion Ops uses.

## Owners

Each responsibility has exactly one owner. The Director chooses. The owners act.

| Responsibility | Owner | Director role |
| --- | --- | --- |
| User answers, tools, context, wording | Existing AIRI chat pipeline and Core gateway | Attaches to the existing answer. It never starts a second one. |
| Speech output, interruption, barge-in | Stage voice controller | Receives speech ownership reports. Opt-in speech goes through Spark. |
| Watch sessions and media sources | R6 `MediaSourceManager` and `CompanionWatch` | Reads a typed snapshot. Offers candidates. |
| Reaction admission and cooldown | R6 `ReactionPolicy` | None. R6 admits every visual and spoken watch reaction. |
| Memory retrieval, provenance, corrections | R4 | Bounded recall. Change notices revoke cached continuity. |
| Screen perception and privacy | R5 | Content-free screen state. Privacy states revoke screen-derived work. |
| Avatar rendering and animation | Stage `ThreeScene`, Vivid controller in `VisualPresenceHost` | Semantic behavior and activity requests only. |
| Routing, quotas, profiles | R2B gateway | Optional reasoning uses the existing gateway and alias. |

## Core runtime

`CompanionRuntime` creates `CompanionDirector` when `director.enabled` and the server channel are on.

- Identity: the configured user (`memory.userId`) and the character of the newest authenticated AIRI turn
  (`x-airi-character-id`). No turn means no Director. A new character disposes the old Director, its relay, its
  attachments, and its visual requests before the new one starts.
- Canonical request: one AIRI round (`x-airi-session-id`, `x-airi-round-id`) is one opaque request id. Tool rounds and
  retries of a round reuse it. `ConversationLedger` lets one Director output attach to the existing answer.
- Evidence: conversation (from gateway turns), user voice (`input:voice:activity`), companion speech
  (`output:voice:activity`), watch snapshots and moments (CompanionWatch subscription), screen state (R5
  subscription), memory change notices (R4), and Ops activity declarations.
- Watch moments: `paused` becomes a `pause` candidate with the `curious` affect. A confirmed `finished-episode`
  becomes an `episode-end` candidate with the `amused` affect. One update with both keeps the most salient one.
- Projection: media ids, screen sources, and request ids become opaque hashes. Titles, captions, window names, file
  names, and screen text never enter the Director or its status.

## Conversation and speech

A user request always gets exactly one answer from the existing pipeline. The Director never blocks it.

1. The gateway turn registers the round in the ledger and submits a `conversation` event and a bounded R4 recall.
2. A `respond-user` decision attaches the Director output id to that answer.
3. The stage reports `output:voice:activity` for the answer's turn. The host maps it to the attached output id, so
   the Director never cancels its own output. Speech of another turn preempts the Director.
4. The attachment resolves `delivered` when the final answer completed and its speech ended. It resolves `cancelled`
   when the turn failed or the Director aborted.

Opt-in speech (`continue-conversation`, `follow-up`) and spoken watch reactions use the existing Spark path:
`spark:notify` with `requiresAck: true`, routed to the stage modules. The stage reports `spark:emit` states:
`working`, then `done` only after the spoken reaction finished, else `dropped`, `expired`, or `blocked`.
The Core revokes its own notify with `spark:emit` `dropped`. The stage then drops the queued notify or stops its speech.

User speech wins at once. The stage barge-in stops speech locally. R6 hears `input:voice:activity` on its own
channel client. The Director preempts its output before queue processing.

## Watch reactions

`WatchReactionRelay` connects the Director to the existing R6 owner.

- `offer` calls `CompanionWatch.offerReaction`. `validatePermit` calls `CompanionWatch.validPermit`, which checks the
  exact permit with the active session's `ReactionPolicy.valid`.
- CompanionWatch delivers an admitted permit to the Director's reaction output only when the relay owns it. A permit
  for another caller's candidate keeps R6's original Spark output.
- A declined or cancelled delivery throws, so R6 records no shared reaction.
- A visual reaction is delivered only when the stage answers `output:visual:result` `started` within one second.
- A spoken reaction fits the R6 permit window (at most 5 seconds) and stops when dialogue resumes.
- A direct answer while watching is conversation output, not an R6 reaction. It never consumes the R6 cooldown.

## Visual presence in the Stage

`VisualPresenceHost` runs the accepted Vivid controller inside the existing VRM renderer.

- Pose phase: `ThreeScene.setVrmFrameHook`, after mixer sampling and before the humanoid update.
- Expression phase: `ThreeScene.setVrmExpressionFrameHook`, after blink, ACT, and lip sync. No flush while ACT or lip
  sync owns the face.
- Owners: speaking (the speaking store), lip sync (active visemes), ACT, and a click on the avatar release procedural
  motion at once. Listening outranks reactions.
- Activity: stage-local `listening` (the user records), `waiting` (speech transcription), and `thinking` (a chat
  request without speech yet) outrank remote `watching`.
- Models: a model or renderer change releases the old adapter before upstream disposes the model.
- Live2D: not wired in this integration. The Vivid Live2D adapter needs Cubism bindings from model configuration, and
  the user's corpus has no Live2D model. The stage reports `available: false` for Live2D.

Director affects map 1:1 to accepted Vivid behaviors: `amused`, `curious`, `surprised`, `concerned`, `focused`.
`curious` uses its own catalog behavior.

## Channel events

| Event | Direction | Data |
| --- | --- | --- |
| `output:voice:activity` | stage to modules | `active`, `outputId` (turn id or `spark:<notify id>`), `sessionId`. Renewed every 4 s while active. |
| `output:visual:request` | module to stage | `requestId`, optional `behavior`, `activity`, `intensity`, `leaseMs` |
| `output:visual:cancel` | module to stage | `requestId`. Only that request's behavior stops. |
| `output:visual:result` | stage to modules | `requestId`, `result` (`started`, `blocked`, `cooldown`, `unsupported`, `unknown`, `disposed`) |
| `output:visual:state` | stage to modules | `available`, `blocked`, `owners` (`speaking`, `lip-sync`, `act`, `manual`) |
| `spark:notify` `requiresAck` | Core to stage | Existing Spark notify. The stage acknowledges it. |
| `spark:emit` | both | Stage: progress and result, routed to `instance:<producer>`. Core: `dropped` revokes its own notify. |

## Core API for Companion Ops

All routes need the ops token. The inference token is rejected. Model output, page content, captions, and vision
never reach these routes.

`GET /ops/director/status` returns `{ "enabled": false }` when the Director is off. Otherwise:

| Field | Content |
| --- | --- |
| `enabled`, `bound`, `channelConnected` | Booleans. `bound` is false before the first authenticated turn. |
| `userControls` | Controls that authenticated Ops requests set in this Core process. |
| `director.configuration` | `enabled`, `proactiveSpeech`, `quietMode`, `privateMode`, `reactionFrequency`, `reasoningEnabled`, `utcOffsetMinutes`, `quietPeriods` |
| `director.attention` | `activity`, `confidence`, `source`, `tentative`, `validUntil`, `userSpeaking`, `companionSpeaking`, `working`, `typing`, `watching`, `watchEvidence`, `dialogue` |
| `director.mood`, `director.energy`, `director.reaction` | Valence, arousal, warmth, tone. Energy 0 to 1. Current short reaction affect. |
| `director.lastDecision` | `action`, `reason`, `at`, `origin`, `salience` |
| `director.metrics` | Accepted, invalid, stale, duplicate, overflow, suppressed, decision, speech, visual, record, reasoning, recall, failure, and cancellation counts |
| `director.resources` | Queue, ids, candidates, fingerprints, history, and active versus in-flight (quarantined) lanes |
| `director.continuity` | Counts only |
| `relay` | `pending`, `delivering` |
| `conversation` | Ledger counts: `requests`, `generating`, `attached` |
| `speech` | Spark speech `pending`, `delivered`, `declined`, `cancelled` |
| `visual` | Stage `available`, `blocked`, `owners`, `owned`, `watching`, and request counts |
| `counters` | Identity switches, admissions by result, watch moments, screen events, memory notices, speech reports |

The status holds no identities, request ids, conversation text, captions, titles, memory text, tokens, or provider errors.

`POST /ops/director/configure` takes any subset of the controls:

```json
{
  "enabled": true,
  "proactiveSpeech": false,
  "quietMode": false,
  "privateMode": false,
  "reactionFrequency": "low",
  "reasoningEnabled": false,
  "utcOffsetMinutes": 330,
  "quietPeriods": [{ "startMinute": 1380, "endMinute": 420 }]
}
```

Quiet periods are daily local minutes with the given offset. A period can cross midnight. Equal ends mean the whole
day. An invalid body returns 400. The controls apply to every later Director instance. Core saves them in
`companion-ops.sqlite` and restores them after a restart (see [companion-ops-paid-gemini.md](companion-ops-paid-gemini.md)).
Proactive speech and reasoning are never read from the configuration file.

`POST /ops/director/cancel` with `{}` cancels Director-owned speech, visual behavior, and queued intentions.

`POST /ops/director/activity` with `{ "activity": "working" | "idle" | "absent" | "unknown" }` records an explicit user
declaration for ten minutes. It outranks older conversation evidence.

Watch routes are unchanged: `GET /ops/watch/status`, `POST /ops/watch/source`, `POST /ops/watch/anilist`.

## Configuration

```json
{
  "director": {
    "enabled": true,
    "reactionFrequency": "low",
    "quietMode": false,
    "utcOffsetMinutes": 330,
    "quietPeriods": [],
    "reasoningAlias": "companion-reason"
  }
}
```

Without `reasoningAlias`, optional reasoning stays unavailable. The alias must have role `reasoning` and match the
profile rules of R2B. The host submits no reasoning request in this integration, so no model call happens.

## Validation

- Combined Core tests: `test/companion-director.test.ts`, `test/companion-director-gateway.test.ts`.
- Stage tests: `src/libs/visual-presence/host.test.ts`, `src/libs/voice/speech-output-announcer.test.ts`,
  `src/stores/character/index.test.ts`, `src/stores/character/orchestrator/index.test.ts`.
- Renderer tests: `packages/stage-ui-three/src/composables/vrm/lip-sync.test.ts`.
- Live probes: `services/companion-core/eval/director/live-stack.mts` and `live-stage.mts`. Performance:
  `perf-host.mts`.
