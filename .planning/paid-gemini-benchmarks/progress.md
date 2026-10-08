# Progress

## 2026-10-09 final evidence and verification

- Closed all paid phases after 473 requests. Estimated charges total USD 0.340722225.
- Every reservation settled. The ledger has no unresolved entries, retained exposure, or process lock.
- Guard tests now cover 52 deterministic cases. They validate limit rejection, ambiguous usage, concurrency, cancellation, and restart safety.
- Measured direct, baseline, paid, reminder, context, tool, vision, concurrency, persona, and synthetic voice-text workloads.
- Added the actual five-function AIRI fixture envelope. Synthetic inputs averaged 3,473 reported tokens in that phase.
- Added loopback cancellation, HTTP 503 failover, and HTTP 429 retry measurements without paid requests.
- Existing upstream text chunking was replayed from recorded stream arrivals. No physical audio latency is claimed.
- Flash 3.8 low is the provisional default. Lite 3.1 minimal is fastest. Flash 3.8 medium gave the strongest reviewed character excerpts.
- Larger paid context retained synthetic anchors lost by the fixture baseline. Normal prompt budgets remain unchanged in production.
- Generated explicit monthly scenarios, routing examples, the blinded worksheet, and the A–R report.
- Independent financial review found no remaining blocker. Reporting caveats were addressed. A later review turn ended at the agent account limit.
- Source and evidence were committed separately. The authorized branch push succeeded and remote HEAD matched.
- Core typecheck and root typecheck passed. Changed-source lint passed in the previous focused run.
- Broader Core tests reproduced an inherited retry-timing assertion. The exact base also fails that assertion under Node 26.7.0.
- The first parallel broad run had a worker exit. Serial runs removed that exit and retained the inherited assertion failure.
- Final Core suite: 876 passed, one skipped, one inherited retry assertion failed. Exact-base persona suite: nine passed, the same assertion failed.
- Root typecheck passed all 56 tasks. Focused lint passed for new TypeScript, package metadata, and routing examples.
- Root lint first crashed after zero errors and 651 warnings. A raw rerun passed with the same warning count.
- ccusage monitoring completed. Agent-account usage remains separate from the Gemini campaign ledger. The account summary stays outside the repository.
- No production configuration, credential store, billing setting, avatar asset, Director integration, or other worktree was changed.

## Publication evidence

- Source commit: `aa9179439427ccffc9b10a9730230604bce874de`.
- Evidence commit: `aa636cae14640cb7d0b9f28d1521b5def38a6e79`.
- Remote branch was created without a merge or force push. The exact base remains `4eabf3daa9d8c8558964ebdb37b242cbf31533f5`.
- The source worktree remains at its original HEAD with its pre-existing VS Code package change.
- All report links resolve. Evidence checksums match. Source matches the 52-test receipt. Credential scans found zero literal matches.
- The repository ignore pattern excludes result files. Explicitly staged the required `results.json` without changing ignore rules.
- Signature values are redacted in committed copies. Synthetic raw replies and reported usage remain intact.
- Remaining production acceptance: human dialogue scoring, physical voice timing, exact paid quotas, final billing reconciliation, and Claude integration.

## 2026-10-08 19:20 UTC measured workloads

- Completed 204 latency calls, five pilots, 20 reminder trials, and 144 quality turns.
- Ledger spending was USD 0.2102709, with zero unresolved usage.
- Paid Gateway preparation and routing contributed milliseconds. Provider/network time dominated short-turn latency.
- The reminder fixed closing-marker failures in 20 short trials, but multi-turn ACT validity still needs improvement.
- The source receipt now hashes all Core source, persona contracts, and the dependency lockfile.
- Added offline replay through the existing upstream TTS word chunker. Its deterministic test passed, bringing the guard suite to 46 tests.
- A pnpm automatic refresh ran workspace installation hooks before tests. Restored unrelated generated changes and lockfile churn.
- The final lockfile change contains only the internal audio-package development link. Frozen installation with scripts disabled passed.
- Context, capability, concurrency, and voice-text phases now run sequentially under the same ledger.

## 2026-10-08 18:50 UTC safety preflight

- Forty-four deterministic tests passed through the reproducible preflight command.
- Companion Core typecheck passed with Node 26.7.0.
- Fixed reviewer findings: conflicting output limits, incomplete usage, concurrent route attribution, and malformed ledger settlements.
- The preflight receipt binds source, tests, prices, and project metadata. Paid calls require fresh matching fingerprints.
- Every request reserves the full advertised input capacity and a combined thinking/output cap before network dispatch.
- In-flight concurrency is two. Unknown usage retains exposure and stops further paid requests.
- Metadata discovery returned all four selected candidates. No paid inference has occurred.
- Gemini 3.7 and 3.8 require low, medium, or high thinking. Minimal is invalid for these models.
- Next: one Flash-Lite pilot, then inspect final usage and cost.

## 2026-10-08

- Read RTK, Superpowers, Planning with Files, and Context Mode workflow instructions.
- Verified repository, base, remotes, worktrees, and credential presence with redacted checks.
- Created the requested isolated branch and worktree. Rechecked after interruption.
- Opened official Google model, price, and quota sources.
- Paid inference remains disabled. Estimated task spending: $0.00.
- User supplied the Gemini project identifier and confirmed the environment key.
- Installed dependencies offline in the isolated worktree under Node 26.7.0.
- Implemented integer nanodollar accounting, price tiers, usage validation, durable reservation ownership, concurrency, and fail-closed restart behavior.
- Verified RED then GREEN: all 22 safeguard tests pass. Typecheck started.
- Accepted paid-tier addendum. Source audit and baseline/paid comparison added to the plan.
