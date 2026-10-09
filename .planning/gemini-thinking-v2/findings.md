# Findings

- The original benchmark worktree is clean at the requested SHA.
- The integration worktree remains on `4186122b3`. This task has a separate branch and worktree.
- Official thinking documentation lists minimal, low, medium, and high for 3.5 and 3.6 Flash.
- Official documentation lists low, medium, and high for 3.7 and 3.8 Flash.
- Gemini 3 minimal does not guarantee disabled thinking. Verify actual project behavior and reported thought tokens.
- Official current Flash standard prices show $0.75 input and $3.75 output per million tokens through 2026-12-31.
- Output pricing includes thinking tokens. Refresh exact Lite pricing before dispatch.
- Source: https://ai.google.dev/gemini-api/docs/thinking
- Source: https://ai.google.dev/gemini-api/docs/pricing
- Source: https://ai.google.dev/gemini-api/docs/openai

Authenticated discovery returned all requested model IDs with 1,048,576 input and 65,536 output token limits.
Metadata presence does not prove generation access or billing tier.
The original guard reserves the full input capacity. 3.5 Flash requires more than $1.57 for each reservation.
The user increased the V2 total allowance to $5.00 and requested a tested request-specific bound.
The pilot completed six paid requests for $0.008241, with terminal usage for each request.
The initial latency process omitted in-process warmups. Preserve its first block as cold transport evidence.
Collect one additional warm sample per primary setting after explicit warmups. Do not repeat the matrix.
Review reproduced split ACT opener corruption in offline voice replay. A regression requires complete spoken words.
Context statistics require separate groups for each context size. Empty voice samples must preserve billed failure evidence.

First character-pass medians are approximately 6.3 seconds for 3.8 medium and 7.9 seconds for high.
Their reply lengths remain similar to low. Human review has not established a compensating personality benefit.
ACT failures occur in 3.5 minimal and Flash-Lite minimal. Do not hide these as missing latency values.
Both Live IDs appear in authenticated metadata. Successful generation access remains untested.
Live billing includes audio and rebilled history. The existing text-only terminal accounting cannot certify session settlement.

## Final analysis checkpoint

Paid dispatch is halted on request `aa76f763-784a-4ff5-aa61-2e93faa1db23`. No authoritative usage record exists locally.
There are 330 settled requests costing $0.470296500 and one locked $0.801792000 reservation.
V2 maximum exposure is $1.272088500. V1 plus known V2 is $0.811018725.
The full input-capacity reservation remains the defensible bound. The $5 authorization admitted 3.5 minimal without reducing it.
The planned warm top-up, secondary levels, detail extension, tools, context, and direct phases cannot run through this halt.

Balanced analysis and the blinded worksheet use 198 turns across 66 complete three-turn conversations.
Seven unmatched or failed attempts remain in the retained transcript file. They do not enter balanced cost or quality means.
Warm controlled first-text p50 is 1.704 seconds for 3.6 minimal and 2.357 seconds for 3.8 low.
Medium and high are 6.090 and 7.578 seconds. Controlled p95 is ineligible because each configuration has fewer than 20 usable warm observations.
High did not become consistently verbose. No completed human scoring establishes a personality improvement.
Fast, Balanced, and Deep proposals are 3.6 minimal, 3.8 low, and 3.8 medium. They remain provisional and inactive.

Live generation spending is zero. The Live section documents API contracts and rejects unbounded paid sessions.
Keep Mura's local TTS. No microphone, playback, English/Japanese voice, interruption, or physical first-audio comparison ran.
Final focused verification passes 179 tests. Root typecheck passes 56 tasks. Lint reports zero errors and 651 existing warnings.
The credential-pattern scan found no secrets in 63 candidate files. Recorded samples contain no raw thought-signature fields.
