# R7A progress

## 2026-10-08

- Started standalone R7A foundation work from the user-specified design.
- Created the isolated worktree and branch from the exact integration SHA.
- Read RTK, Superpowers, Planning with Files, and repository instructions.
- Applied Context Mode to architecture and workflow evidence.
- CodeGraph is unavailable for this worktree. No indexing action was taken.
- Next: inspect contracts and write the implementation design.

- Inspected the actual R4/R5/R6 contracts and accepted visual contract without editing those owners.
- Verified the R6 `offerReaction` seam and cancellation responsibilities in source.
- Installed dependencies from the frozen lockfile offline in this worktree. No provider or utility dependency was added.
- Recorded aggregate ccusage baseline and its attribution limits.

- Recorded the Director ADR, bounds, interfaces, policy invariants, and verification sequence.
- Initial TDD run failed because the new Director module did not exist.
- Implemented validated projection, attention TTLs, gradual mood, salience, initiative, cancellation, and bounded async lanes.
- Initial policy suite passes: 10 tests. It includes 12 hours of idle, 1,500 mood events, and a 5,000-event storm.
- Next: test R4 provenance/corrections, real R6 admission, optional routed reasoning, and late-result cancellation.

- The interrupted dependency build did not complete. After the user enabled full access, existing SDK/runtime dependency builds passed.
- Real R6 policy tests pass for dialogue-gap admission, silent-reaction cooldown, interruption, unrelated permits, and subtitle injection.
- Actual R4 SQLite recall preserves user-stated plans and canonical provenance. Invalid, foreign, stale, and contested evidence is rejected.
- Four new regressions failed first: dispatch after privacy, premature visual guard expiry, expired dialogue gaps, and active speech crossing new dialogue.
- Corrected all four lifecycle paths. The Director suite reached 30 passing tests and the affected typecheck passed.
- Added bounded optional reasoning and its existing-gateway adapter. Nine additional tests pass, including a real R2B quota-ledger run.
- Non-cooperative ports retain one quarantined physical lane. Timeouts never spawn unlimited retries.

- Added an eight-hour realistic replay and a twelve-hour idle probe with a controllable virtual clock.
- Added 100,000-event consecutive and storm measurements. Queue, IDs, candidates, fingerprints, history, and async lanes remain bounded.
- Reproduced and fixed independent activity energy, preservation of canonical watch speech, and admitted permit deadline cancellation.
- Reproduced and fixed declined watch delivery reporting, inferred commitment recall, inferred correction authority, and preflight bounds before array traversal.
- Low-confidence and repeated screen evidence cannot renew emotional reaction or mood.
- Director validation now has 56 passing tests. Full Companion Core validation passes 765 tests with one existing helper test skipped.
- Prepared the existing extension generated types. Used two workers to avoid the existing capture test's parallel timing failure.
- Root typecheck passes all 56 tasks after building existing i18n declarations in the isolated worktree.
- Corrected scoped lint formatting with dry-run output and native patches. Root lint passes with zero errors and 651 existing warnings.
- Wrote subsystem README and exact future integration instructions. R6 needs its own typed snapshot and live permit validation exposed during later integration.
- Preserved final synthetic measurements and test coverage in the report and JSON artifact.
- ccusage follow-up reports 561,415,708 aggregate day tokens. Other sessions are included and the model remains unpriced.
- Staged 28 R7-only files. The required fresh-context read-only reviewer is inspecting the foundation before commit.
- Independent review reproduced three important issues: owned speech self-cancellation, stale watch evidence treated as stopped playback, and follow-ups outliving R4 support.
- Owned speech correlation now passes new regressions. Remaining evidence-lifetime regressions are being added before fixes.
- The reviewer hit the account usage limit before a final verdict. Preserve its findings and continue verification without expanding scope.
- Resumed the same reviewer after the usage reset. It confirmed all three fixes and found a fourth R5 revocation issue.
- Added immediate screen invalidation, acquisition deadlines, source-key binding, and pending-candidate removal.
- All four review findings have behavioral regression coverage. Director has 68 tests. Full Core passes 777 tests and one existing opt-in desktop test is skipped.
- Refreshed measurements after the fixes: 100,000 consecutive events in 524.2 ms, 100,000 storm events in 354.0 ms, and an eight-hour 3,849-event replay.
- Root typecheck and scoped lint pass after the review fixes. Final root lint and the review verdict remain before commit.
- Final root lint passes with zero errors and 651 existing warnings outside R7.
- The reviewer independently reran all 68 Director tests and rechecked all four fixes. No Critical or Important issue remains; standalone delivery is ready.
- Final source, tests, documentation, and measurements are being staged for the authorized commit and branch push.
- Final staged scope contains 28 R7-only files at the exact requested base SHA. There are no unstaged changes, whitespace errors, or broken relative documentation links. Source, tests, evaluation, and all new Markdown pass scoped lint.
- Committed the implementation as `a0d21ebf46b0ceb0c8435863cb5c275244fe0cfb` and pushed `codex/r7-director-foundation` to origin. Its parent is the exact requested base. `git ls-remote` independently confirms the implementation commit on the remote branch.
- Recorded the verified handoff in this documentation-only follow-up. No merge or production integration was performed; the isolated worktree is retained for integration review.
