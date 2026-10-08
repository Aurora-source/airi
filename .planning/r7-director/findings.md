# R7A findings

## Workspace

- Origin is `https://github.com/Aurora-source/airi.git`.
- The requested integration branch resolves to the exact supplied SHA.
- New worktree: `D:/AI/airi-r7-director`.
- New branch: `codex/r7-director-foundation`.
- Existing concurrent worktrees and branches remain untouched.

## Tools and evidence

- Read `C:/Users/Rikon/.codex/RTK.md`.
- CodeGraph reports that this repository is excluded from `D:/AI/.codegraph`. It has no local index.
- The full 1,978-line architecture file is indexed in Context Mode as `R7 AIRI Architecture V2`.
- RTK, ccusage, pnpm, Node, and Git are installed.
- Repository rules require TypeScript, Vitest, simple English, scoped tests, root typecheck, and root lint.

## Product invariants

- Proactive speech starts disabled.
- Idle duration alone never causes speech.
- User speech and media dialogue preempt initiative.
- R6 owns Watch Together admission, expiration, and cooldown.
- R7 requests visual behavior without controlling animation or bones.
- Recall and commitments require actual R4 provenance and character scope.
- External metadata remains data. It never grants instruction authority.
- Status diagnostics contain reasons and counters, without private conversation or raw observations.

## Source contracts

- R4 owns `MemoryQueryPort`, `MemoryItem`, `Provenance`, and memory administration in `src/memory/ports.ts`.
- R4 categories include `goal`, `promise`, `open_thread`, and `relationship`. Active state alone does not establish valid provenance.
- R5 exposes `CurrentWorld`. Non-fresh results withhold observations. Low-confidence facts never establish user activity with certainty.
- R6 owns `WatchSnapshot`, `ReactionCandidate`, `ReactionPolicy`, and `ReactionPermit`.
- `CompanionWatch.offerReaction()` is the actual integrated admission seam. R7 must supply candidates to it.
- R6 permits expire with media, playback, and silence evidence. Voice adapters must honor cancellation throughout output.
- Read the R6 report, watch README, and shared R6 handoff notes read-only.
- The accepted visual branch defines `VisualBehaviorPort` in `packages/model-driver-visual/src/contracts.ts`.
- That package is absent from this base. A neutral Director intent port avoids importing or copying the unmerged renderer contract.
- R2B `/v1/chat/completions` already enforces configured profiles, capabilities, quotas, and routing.

## Validation environment

- Installed the existing lockfile offline in this worktree with scripts disabled. No dependency or lockfile change is required.
- RTK initially reported `ok` without useful install detail. Raw replay verified successful installation and one missing server-runtime executable warning.
- Context Mode file access became rooted at its plugin directory. Native targeted reads remain authorized within `D:/AI`.
- ccusage baseline reports 477,022,271 aggregate local-record tokens for the day. These cover other sessions and agents.
- ccusage does not price `gpt-6.1-sol`. Usage totals cannot establish this task's cost.

## Implementation evidence

- Thirty Director policy, memory, watch, and lifecycle tests passed after regression fixes.
- Nine reasoning tests passed. One starts the actual gateway and verifies that the second reasoning request hits its RPD limit.
- The affected typecheck passed after building existing SDK/runtime dependencies.
- Visual intents retain a six-second cancellation lease after the synchronous request is accepted.
- Dialogue gap evidence has an independent expiry. Fresh playback cannot extend a stale gap.
- Output cancels when a new media dialogue begins. Same-turn private mode prevents delayed external dispatch.
- R4 query output is data only. Its generated prompt is ignored by the Director.

- The eight-hour replay processes 3,848 events with reactive user answers and R6-admitted visuals. Idle, absent, and quiet phases stay silent.
- The initial 100,000-event probe used less than 90 KiB of retained heap after GC. This is one synthetic sample, not a production memory guarantee.
- Actual gateway tests verify LOCAL quota admission, CLOUD failure without added local fallback, and the configured HYBRID fallback chain.
- The integrated R6 owner keeps its exact policy and snapshot private. Later composition must expose narrow read-only capabilities, not create a second admission policy.
- R6 treats a successful void reaction callback as delivered. The relay returns an outcome so the later adapter can reject non-delivery and avoid a false shared milestone.
- The base extension needs `wxt prepare` before the full Core suite. The existing capture cancellation test is timing-sensitive under high worker concurrency.
- RTK's compact `pnpm typecheck` invoked a different check and produced irrelevant root TypeScript errors. Raw replay of the actual package script confirmed 56 successful tasks.
- Final post-review validation passes 68 Director tests and 777 Core tests, with one existing opt-in desktop test skipped. Root typecheck passes 56 tasks; root lint has zero errors and 651 existing warnings outside R7.
- The refreshed eight-hour replay processes 3,849 events, including an explicit R6 stop snapshot. It produces 25 reactive answers and 24 admitted visual reactions; idle, absent, quiet, and watch speech remain zero.
- The independent reviewer read all 28 added files and found no remaining Critical or Important defect after rechecking the four ownership and evidence-lifetime fixes.
- Implementation commit `a0d21ebf46b0ceb0c8435863cb5c275244fe0cfb` is a direct child of the requested base. The origin branch was pushed and its implementation SHA verified with `git ls-remote`. Production integration remains separate.
