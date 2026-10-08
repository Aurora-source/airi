# R7A architecture decisions

## ADR-01: Standalone foundation

R7 owns cognition, bounded events, and decisions. Integration ports own external effects.
Production stage integration is deferred by explicit user instruction.

## ADR-02: Conservative initiative

Proactive speech requires explicit opt-in. Silence is the default.
Idle and absence produce no speech candidates. User speech and dialogue block speech.

## ADR-03: Existing capability ownership

R6 retains reaction admission. R4 retains memory provenance and persistence.
Visual presence retains behavior implementation. R2B retains routing and quota enforcement.

## ADR-04: Bounded evidence

Events, deduplication, salience, diagnostics, and optional reasoning have explicit bounds.
The Director receives a clock and advances state on events. It does not poll cloud models.

## ADR-05: Scope and tooling

The supplied architecture and requirements authorize execution. Tooling cannot expand scope.
No new repository index, provider system, frontend, or external utility dependency is required.

## ADR-06: Semantic visual intents

The accepted Vivid contract is absent from this base. R7 emits independent domain intents.
The future host maps these intents onto the actual VisualBehaviorPort after integration.
R7 does not copy renderer contracts or add a visual package dependency.

## ADR-07: R6 admitted-permit relay

Watch reactions use one handoff tied to the existing candidate and permit types.
The relay calls offerReaction and waits for the actual R6 admission callback.
All modalities share R6's admission and cooldown. No visual shortcut exists during watching.

## ADR-08: Optional bounded reasoning

The optional adapter calls the existing loopback chat-completions gateway with a reasoning alias.
Only structured state reaches the model. Output can select silence or a semantic visual reaction.
The gateway retains strict compute profiles and quota enforcement. The Director never retries on an idle timer.

## ADR-09: Integration ownership

The complete design and verification sequence are recorded in `docs/ai/adr/2026-10-08-director-foundation.md`.
Constructor ports follow existing Companion Core boundary injection. No dependency container or provider system is added.
## Follow-up boundary decisions

- Activity energy owns a separate state machine from reaction and mood. It is a score of current activity, never a fatigue claim.
- R4 plans need user-stated provenance. Promises and threads need a non-inferred supporting edge. Inferred corrections cannot revoke actual continuity.
- Suppressed or low-confidence external observations never renew emotional state.
- R6 handoffs preserve speech purpose and canonical request. Relay outcome reporting prevents false delivered/shared reactions.
- R6's actual permit deadline owns admitted delivery cancellation. A separate injected-clock timer enforces the same earlier deadline in simulations.
- Array length preflight runs before element validation. Model responses have byte and fragment bounds.
- Owned speech echoes an opaque output correlation token. It cannot cancel itself, while unrelated voice output still preempts it.
- Stale watch context remains uncertain until the R6 owner explicitly reports idle or cancelled. Expiry never proves playback stopped.
- Memory-based candidates and speech bind actual item versions and validity deadlines. Replaced or expired support revokes effects.
- Screen revocation applies at ingress, before queue admission. Pending candidates and live leases require current source-key evidence and acquisition-based deadlines.
