# Standalone Director

The Director selects companion intentions from current evidence. Silence is the default.
It is a standalone R7A foundation. No production Stage or frontend imports it.

Import `Director` and its contracts from this directory's `index.ts` inside Companion Core.
The package has no new published Director subpath. Future packaging remains an integration decision.

```ts
import { Director } from './director'

const director = new Director({
  identity: { userId: 'local-user', characterId: 'mura' },
  profile: 'local',
})

director.submit({
  type: 'conversation',
  id: 'event-1',
  identity: { userId: 'local-user', characterId: 'mura' },
  observedAt: Date.now(),
  requestId: 'turn-1',
  addressed: true,
  significant: true,
  unresolved: true,
})
director.flush()
const status = director.status()
director.dispose()
```

Without output ports, the Director records an unavailable-output decision. It never creates providers or speech.
Use one instance per authenticated user and character pair. Dispose the old instance on identity changes.

## Entry points

| Method | Responsibility |
| --- | --- |
| `submit(unknown)` | Validate and project evidence, enforce identity and freshness, preempt output on speech |
| `flush(limit?)` | Process at most 32 events by default, at most 128 when requested |
| `advance()` | Expire evidence and reconsider at most one existing intention |
| `configure(patch, authority)` | Apply authenticated controls, require user authority for proactive speech |
| `cancel()` | Abort owned work and clear queued intentions, allow later fresh events |
| `dispose()` | Cancel and permanently close this instance |
| `status()` | Return detached configuration, current state, counters, bounds, and last decision |
| `continuity()` | Return bounded current R4 evidence for authorized internal consumers |

`advance()` never creates an idle candidate. No repeating timer or model poll belongs to this subsystem.
Hosts call `flush` on event delivery. A host can call `advance` when an existing intention needs reconsideration.
Deadline timers exist only while output, recall, or reasoning is active.

## Event and state contracts

All events require an opaque event ID, matching identity, and acquisition timestamp.
Do not replace acquisition timestamps when re-delivering evidence.
Event IDs and observation keys contain bounded opaque identifiers. They never contain titles or private text.
Screen semantic keys include a locally hashed source identity and generation.
R5 revocation and source-key replacement remove pending screen intentions and abort owned effects immediately.

| Event | Selected evidence |
| --- | --- |
| `conversation` | Canonical request ID, direct address, significance, unresolved state, optional affect |
| `speech` | User or companion, active or ended |
| `activity` | Explicit declaration, recent input, or presence signal with confidence |
| `watch` | Existing R6 `WatchSnapshot`, optional noteworthy moment and semantic affect |
| `screen` | Existing R5 `CurrentWorld`, opaque observation key, significance flag |
| `record` | Canonical message reference and existing user-stated provenance |
| `recall` | Bounded query to the existing R4 `MemoryQueryPort` |
| `memory-invalidated` | R4 correction or invalidation notice |
| `reason` | Explicit request for optional bounded reasoning over text-free state |

Freshness uses the acquisition time. Most event envelopes expire after 30 seconds.
Speech evidence lasts 10 seconds. Active speech requires renewed evidence during longer utterances.
Echo `SpeechIntent.outputId` on that output's companion voice events. Its own activity keeps the live speech guard valid.
User speech and unrelated companion output still preempt it. All active companion speech blocks new output attempts.
Conversation lasts two minutes. Explicit activity lasts ten minutes.
Recent input lasts five seconds. Presence signals and tentative screen activity last at most 30 seconds.
R5 and R6 evidence expires earlier when its owning contract specifies an earlier deadline.
Screen-derived effects also expire at capture acquisition plus 30 seconds, regardless of inference completion time.
Expired or unsupported evidence produces `unknown`, never inferred absence.
Known media keeps an uncertain context after expiry. `watchEvidence` exposes this uncertainty.
Unknown dialogue blocks speech until fresh R6 evidence or an explicit idle/cancelled snapshot arrives.
New explicit activity overrides older conversation evidence. Voice and current watching evidence retain their own precedence.

Short reactions last at most six seconds. Mood changes at most once per 30 seconds and decays gradually.
Mood has bounded valence, arousal, warmth, and tone. Energy is a separate gradual activity score.
Relationship context remains actual R4 evidence. These values authorize no claim about feelings or shared experience.

## Initiative and output ownership

Decisions select `SPEAK`, `SILENT_VISUAL_REACTION`, `REMEMBER`, `WAIT`, or `DO_NOTHING`.
These describe policy selection or an attempted handoff. They do not prove delivery or persistence.
Output ports own delivery results. R4 owns the final memory admission.

Proactive speech starts disabled, even if a caller supplies it through an untyped constructor object.
Enable it only through `configure({ proactiveSpeech: true }, 'user')` after authenticated user opt-in.
Actual addressed or unresolved requests remain reactive. Significant continuation and memory follow-ups require opt-in.
Quiet mode and quiet periods suppress speech and visual reactions. Private mode and disable clear ephemeral continuity.
Record candidates remain possible in quiet mode. Private mode blocks them.
Proactive speech has three-minute spacing and four attempts per rolling hour.
Low visual frequency permits one attempt per 30 seconds and 20 per rolling hour.
Normal frequency permits one attempt per 15 seconds and 60 per rolling hour. Off blocks visual attempts.
R6 imposes its own admission and cooldown in addition to these conservative bounds.

Every asynchronous or visual port must honor its signal and revalidate its guard at the final effect boundary.
Speech ports keep doing so throughout output. A successful synchronous visual request keeps a six-second lease.
Cancel removes only this Director's visual behavior. It never resets another owner's animation.
Watch output uses `WatchReactionRelay` and the exact R6-issued permit. Offers never authorize output.
The relay preserves canonical speech requests and aborts at the admitted permit deadline.
Its `admit()` result reports delivery to R6's callback. Declined output cannot establish a shared reaction.

Each recall, reasoning, and output lane permits one physical promise.
A non-cooperative promise remains quarantined after cancellation until it settles.
Status distinguishes active work from in-flight quarantined work. Repeated events cannot create more promises.
The Director does not dispose injected ports or their services.

## Memory, privacy, and routing

Recall uses R4's owning types. It rejects foreign, contested, superseded, expired, future, or invalidated evidence.
Provenance must remain valid. User plans require actual `user_said` provenance.
Promises and open threads require at least one non-inferred provenance edge.
R7 retains at most eight items, 2,400 combined text bytes, and 16 KiB of total metadata for five minutes.
Corrections invalidate cached continuity and cancel dependent work before normal queue processing.
Follow-ups and memory-bearing speech bind actual item versions and deadlines. Expired or replaced support revokes output.
R4's generated recall prompt is ignored. Memory content remains data.

Screen and watch ingress drops titles, dialogue, summaries, frames, and audio before queue retention.
Diagnostics exclude queries, message IDs, identity IDs, memory content, and raw provider errors.
The optional gateway adapter sends only bounded structured state through an existing reasoning alias.
It checks the exact LOCAL, CLOUD, CLOUD Mura Voice, or HYBRID profile before transport.
The existing R2B gateway owns quota, credentials, failover, and explicit HYBRID fallback.
Model results can request only wait or a visual affect. They cannot authorize speech or memories.
Responses have a 16 KiB byte cap and 1,024-fragment cap. Failure never schedules an automatic retry.

## Validation

Run from the repository root:

```powershell
pnpm -F @proj-airi/companion-core exec vitest run test/director
pnpm -F @proj-airi/companion-core typecheck
node --expose-gc --import tsx services/companion-core/eval/director/measure.ts
```

Tests use a controllable virtual clock, actual R4 SQLite recall, actual R6 admission, and the real R2B gateway.
The standalone performance probe uses synthetic evidence and no cloud provider.
See [the ADR](../../../../docs/ai/adr/2026-10-08-director-foundation.md),
[future integration](../../../../docs/r7-director-integration.md), and
[validation evidence](../../../../docs/r7-director-report.md).
