# Paid Gemini benchmarks implementation plan

> Use Superpowers executing-plans and test-driven development for implementation. The user supplied the scope and execution authorization.

## Goal

Measure paid Gemini quality, latency, reliability, and cost through direct and existing AIRI Gateway paths. Publish reproducible evidence without changing production.

## Constraints

- Base: `4eabf3daa9d8c8558964ebdb37b242cbf31533f5`.
- Branch: `codex/paid-gemini-benchmarks`.
- Worktree: `D:/AI/airi-gemini-bench`.
- Stop before $4.50. Absolute planning limit: $5.00.
- No paid inference until official pricing, model discovery, isolated credentials, and simulated guard tests pass.
- Preserve LOCAL, CLOUD, HYBRID, context ownership, atomic tool turns, Mura TTS, and VoiceController.
- Synthetic data only. Never log credentials. Never alter another worktree or production settings.
- Keep substantial temporary data under D:/AI.
- Keep source and generated evidence in separate commits. Push the requested branch without merging.

## Phases

1. [x] Verify isolation, credentials, runtime, official prices, source architecture, and exposed contracts.
2. [x] Implement and test durable spend ledger, reservations, discovery, timing, deterministic corpus, and reports.
3. [x] Run guarded pilot. Halt on ambiguous accounting. Compare direct, source baseline Gateway, and paid Gateway paths.
4. [x] Measure context, character, tools, vision, concurrency, cancellation, and instrumentable voice stages.
5. [x] Test a measured ACT reminder change. Provider latency dominates. No speculative runtime optimization was added.
6. [x] Write report, machine evidence, blind worksheet, routing example, monthly model, and reproduction commands.
7. [x] Run required checks, review, commit, push, and verify remote HEAD.

## Review focus

- Missing, inconsistent, or partial usage must retain reserved cost and stop paid execution.
- Thinking and output limits must bound all generated billable tokens.
- Gateway retries and failover must not bypass reservations or CLOUD semantics.
- Cancelled requests can incur charges without final usage.
- Model listing does not prove project quota, access, or billing attribution.

## Next step

Paid measurements are closed. The ledger contains 473 settled requests, USD 0.340722225, and no unresolved reservations.
Source and evidence were committed separately and pushed. Remote HEAD matched the local evidence commit.
Claude can review the report, score the blinded dialogues, and complete physical voice acceptance before production integration.

## Publication

- Source: `aa9179439427ccffc9b10a9730230604bce874de`.
- Evidence: `aa636cae14640cb7d0b9f28d1521b5def38a6e79`.
- Branch: `origin/codex/paid-gemini-benchmarks`.
- Final publication notes remain on the same branch. Resolve their commit with `git rev-parse HEAD`.

## Errors

- Initial worktree command was interrupted. Read-only verification confirmed successful creation at the exact base.
- Large skill reads were truncated. Context Mode now retains large research output and surfaces targeted sections.
- CodeGraph query did not return in a bounded interval. The worktree has no repository index. Use targeted source reads.
- Context Mode web fetch lacks `turndown`. Official Google pages remain available through the web tool.
