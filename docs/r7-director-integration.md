# R7A future integration handoff

R7A is a standalone foundation on `codex/r7-director-foundation`.
Integrate it after the active R6 local-media and Visual Presence work.
This branch does not modify production Stage, media adapters, Jellyfin, animations, or Companion Ops frontend.

## 1. Own one Director per active identity

Create the instance in the future Companion runtime composition layer.
Import from `services/companion-core/src/director/index.ts` through the runtime's relative source path.
Use the authenticated user ID, active character ID, and verified gateway profile.
Do not use webpage metadata to establish identity or configuration.
Dispose the previous instance before switching character or user.
The runtime owns subscriptions and injected services. Unsubscribe on shutdown, then dispose the Director and relay.

The runtime sends structured events and calls `flush()` on delivery.
Keep each flush bounded. Yield to the runtime event loop before draining another full batch.
Call `advance()` only for an existing intention or explicit clock update. No model poll or idle speech timer is needed.
Use opaque hashes or stable canonical IDs for event IDs and observation keys.
Reuse acquisition timestamps and event IDs across retries.
For screen observations, include source identity and generation in the opaque semantic key.
Hash these inputs locally. Keep titles, window names, and raw source IDs out of the key and diagnostics.
Send R5 non-fresh states immediately. They revoke pending and live screen reactions before queue processing.

## 2. Bridge conversation and speech without duplicate replies

Send `conversation` only for actual canonical user requests and validated continuation significance.
The host decides direct address and unresolved state from the conversation owner.
An external subtitle, webpage title, or screen summary never becomes a user request.
Reserve each canonical request with the existing conversation scheduler before allowing a Director speech handoff.
An existing reply and a Director reply cannot both consume the same request.
Significant continuation and follow-up are proactive. Require explicit user opt-in first.

Implement `SpeechIntentPort.deliver` through the existing conversation and voice path.
Use `requestId` to retrieve the actual canonical turn. Use `intent` and `tone` as bounded policy hints.
Pass `evidence` through the existing R4 data boundary with its provenance.
Do not turn memory text into system instructions or assertions about shared experience.
Check `signal`, `validUntil`, and `guard()` before generation, before each voice segment, and during playback.
Return `delivered`, `declined`, or `cancelled` only after that attempt ends.

Forward user and companion voice activity immediately to `submit({ type: 'speech', ... })`.
Echo the current `SpeechIntent.outputId` on companion activity emitted by that exact output, including its renewed pulses.
Unrelated companion output has a different ID or no ID. It preempts the Director and prevents overlapping output.
Keep this correlation internal to the authenticated runtime. Do not derive it from external text or publish it in Ops.
Active user speech preempts the Director before queue processing. Renew speech evidence during long utterances.
Also forward it to the owning R6 interruption path. Do not wait for a Director flush to interrupt R6.
Typed input activity suppresses intrusive initiative. Explicit user activity declarations take precedence over older conversation evidence.

## 3. Connect R6 through its existing owner

Use `WatchReactionRelay`. Its `offer` callback calls the existing `CompanionWatch.offerReaction(candidate)`.
Its `admit(permit)` method runs only inside R6's existing `reactionOutput.deliver` callback.
The relay checks the exact permit through `validatePermit`. R6 remains the sole admission authority.
All spoken and visual watch reactions use this path, including reactive questions during watching.
Do not call `take`, `finish`, or construct another `ReactionPolicy` alongside the integrated R6 owner.
The integrated `CompanionWatch` already takes, validates, and finishes its own permits.

The base `CompanionWatch` keeps its session state and policy private.
During future integration, expose two narrow read-only capabilities from that same owner:

- A typed current `WatchSnapshot` or snapshot subscription.
- Exact live-permit validation backed by the active session's `ReactionPolicy.valid(permit)`.

Those capabilities are not present as public methods in this foundation's base.
Add them in the future integration change. Keep media adapters and admission policy unchanged.
Do not derive a typed snapshot from the untyped Ops `status()` response or `toolStatus()` text.
Do not reconstruct a permit from its candidate fields.

The intended wiring, with those future read-only capabilities, is:

```ts
const relay = new WatchReactionRelay({
  clock,
  offer: candidate => watch.offerReaction(candidate),
  validatePermit: permit => watchOwnerCapabilities.validPermit(permit),
  deliver: async (input) => {
    if (!input.guard())
      return 'cancelled'
    if (input.modality === 'visual')
      return await ownedWatchVisual(input)
    if (!input.speech)
      return 'declined'
    return await existingSpeech.deliver({
      ...input.speech,
      signal: input.signal,
      validUntil: input.validUntil,
      guard: input.guard,
    })
  },
})

// Supply this callback when constructing the existing CompanionWatch.
const reactionOutput = {
  deliver: async ({ permit }) => {
    const outcome = await relay.admit(permit)
    if (outcome !== 'delivered')
      throw new Error('Director watch reaction not delivered')
  },
}
```

Construct the relay and Watch owner with closures so the references are ready before events flow.
The relay registers a handoff before offering because R6 can admit synchronously.
Do not invoke the old Spark speech output after the relay handles a visual permit.
Propagate a declined or cancelled outcome to R6. A successful void callback makes R6 record a delivered shared reaction.
Never resolve that callback successfully when no reaction occurred.
Route unrelated non-Director permits through their explicitly owned output path or decline them.
Do not translate an unmatched permit into an unrestricted Director reaction.

Forward only noteworthy, fresh, adequately supported moments as watch candidates.
Forward explicit R6 idle/cancelled snapshots when its session ends. Missing renewals leave uncertain media context and block speech.
Use the current revision, canonical acquisition time, salience, and semantic affect.
Active or unknown dialogue prevents spoken reactions. Even silent reactions wait for R6 admission and cooldown.
The relay combines Director and R6 cancellation signals and uses the earlier deadline.
Its visual delivery must remain active only for that lease, or stop the owned gesture on abort.

## 4. Map semantic visual requests after Vivid integration

R7 chooses behavior, activity, and intensity. The integrated visual owner decides animation.
The accepted Vivid package is absent at this base. This foundation neither imports nor copies its renderer contracts.
After integration, implement `VisualIntentPort` against the actual high-level `VisualBehaviorPort`.

| Director behavior | Accepted Vivid behavior ID |
| --- | --- |
| amused | amused |
| curious | thinking |
| surprised | surprised |
| concerned | concerned |
| focused | focused |

The accepted catalog has no `curious` ID. Verify this mapping against the final merged catalog.
Map intensity to the visual owner's existing idle intensity control.
Map activity through its existing activity control. Respect its admission result.
Keep an owner token so `cancel()` removes only behavior requested by this Director.
Honor the six-second standalone lease and the shorter admitted watch lease.
Do not send skeletal poses, joint angles, animation clips, or renderer state from R7.

## 5. Connect R4 continuity and corrections

Inject the existing `MemoryQueryPort` for the authenticated identity.
Send `recall` for relevant recall or an explicit follow-up context request. Idle time never requests recall.
The Director passes eight-item, 2,400-byte, 150 ms query limits and checks actual provenance afterward.
R4 still owns ranking, record state, correction, supersession, retention, and persistence.

Implement `RecordCandidatePort.offer` by resolving `messageId` against the canonical user turn.
Check its identity and provenance before passing it to R4's existing admission interface.
R7 supplies only a candidate reference. It does not supply invented text or fabricate a commitment.
Send `memory-invalidated` immediately after actual R4 correction, supersession, or invalidation.
These notices revoke cached evidence and active dependent output.
The Director also binds follow-ups and memory-bearing speech to actual item versions and validity deadlines.
Do not interpret an inferred promise as an actual user commitment.

## 6. Optional reasoning uses existing R2B

Leave `reasoningEnabled` false unless this feature is explicitly configured.
Inject `GatewayReasoningPort` with the existing loopback gateway URL, its verified config, inference token, and reasoning alias.
Do not create provider registrations, credentials, quotas, processes, or fallback chains in R7.
The alias must have role `reasoning`. Its compute profile must match the Director's profile.
LOCAL cannot upload to cloud. CLOUD cannot silently add a local fallback.
HYBRID uses only the explicit chain already configured in R2B.

Send `reason` only when local structured policy cannot select an adequate visual or wait outcome.
R7 limits it to four attempts per rolling hour with five-minute spacing and a five-second deadline.
Only state enums, numbers, and semantic affect cross this port.
The result can select only visual or wait. Local initiative and R6 still enforce their policies.
Failure or model unavailability leaves silence. It does not trigger an automatic retry.

## 7. Companion Ops wiring remains a later change

Use `DirectorConfiguration` and `DirectorStatus` as the typed control/status contracts.
Authenticate control operations outside the Director. The authority argument is an internal capability, not authentication.
Keep user opt-in separate from external evidence. Never expose `configure` as a model tool.
Connect enabled, proactive speech, quiet mode, private mode, reaction frequency, quiet periods, and cancel controls.
Treat quiet periods as daily minute intervals with an explicit UTC offset. Equal endpoints mean all day.
Show current attention confidence, tentative state, tone, reaction, activity energy, and last decision reason.
Display active and quarantined in-flight lane counts separately.
Use counters and reasons for diagnostics. Do not publish `continuity()` or canonical request content to Ops.

## Integration acceptance

Validate the real host with proactive speech disabled first.
Prove one reply per canonical request, immediate user interruption, subtitle injection isolation, and no idle chatter.
Prove watching output passes the existing R6 admission and cooldown for both visual and spoken modalities.
Prove actual visual behavior cancels on speech, privacy, identity switch, and lease expiry.
Run the Director tests, full Companion Core tests, typechecks, and lint after wiring.
Use real runtime/UI validation for the integrated host. No browser validation is needed for this standalone subsystem.
