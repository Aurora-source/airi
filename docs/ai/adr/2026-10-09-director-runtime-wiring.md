# Director runtime wiring

Status: accepted on `integration/r6-media-visual-r7`.
Context: the R7A Director foundation, R6 local media, and Vivid visual presence existed separately. This ADR records how
the runtime composes them without a second chat path, a second admission authority, or a second renderer.

## Decisions

1. **Vivid by cherry-pick.** The three visual commits are cherry-picked with `-x`. Merging the branch would also bring
   six unaudited upstream commits. The package tree equals the accepted branch.
2. **One host per Core.** `CompanionDirector` owns one Director and one `WatchReactionRelay` for the configured user
   and the character of the newest authenticated turn. Another character disposes the old instance first.
3. **The existing answer owns each user request.** `ConversationLedger` maps a round to an opaque request id. A
   Director answer only attaches to the existing answer. Director policy never blocks a user request.
4. **Spark with acknowledgement for Director speech.** Opt-in speech and spoken watch reactions use `spark:notify`
   with `requiresAck`. Delivery follows the stage's `spark:emit` result, never the send result.
5. **Speech ownership reports.** The stage sends `output:voice:activity` with its turn id. The host maps it to the
   Director output id, so the Director never cancels its own speech.
6. **Semantic visual requests.** The Core sends `output:visual:request` and `output:visual:cancel`. The stage owns
   the controller, admission, owner priority, and the lease. A cancel stops only its own request.
7. **R6 stays the admission authority.** CompanionWatch exposes `snapshot()`, `subscribe()`, and `validPermit()`,
   read-only. A reaction output can decline ownership of a permit, and Watch then keeps its default Spark output.
8. **R4 change notices.** CompanionMemory reports changes without content. The host submits `memory-invalidated`.
9. **Controls from authenticated Ops only.** Proactive speech and reasoning are not configuration fields.
10. **Renderer seam reports active visemes.** The stage keeps its last audio source after playback, so the VRM frame
    context reports lip sync from active visemes only.

## Consequences

- Director-disabled mode keeps the previous chat and R6 behavior.
- Spoken Director watch reactions fit the R6 permit window (at most 5 seconds) and stop when dialogue resumes.
- Proactive controls last for the Core process. Companion Ops reapplies them after a restart.
- Live2D visual presence needs model bindings and remains a later change.

## Fixes found during integration

- `useVRMLipSync` treats an ended source as silence. The wLipSync worklet otherwise keeps its last vowel weights, and
  the VRM mouth stays open after speech.
- The notification `SpeechClient` stays raw. A reactive proxy cannot cross the speech bus BroadcastChannel.
- Stage Spark acknowledgements route to `instance:<producer>`. An empty destination list reaches no peer.
