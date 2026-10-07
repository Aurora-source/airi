# R5 perception foundation report

## A. Base, branch and worktree

- Verified base: `0fa1d0ffaaece2e9bb82c6aba49cfd7fdae64175`.
- Branch: `codex/r5-perception`.
- Worktree: `D:\AI\airi-r5`.
- Foundation commit: `caf56ebb898fe96f119c89ee785b7aa23109745d`.
- No merges. No runtime or protected-worktree source edits.
- Read `D:\AI\AIRI_ARCHITECTURE_V2.md`. The parallel-task scope takes precedence over its broader rollout.

## B. Capture design

`ScreenCapturePort` supports fresh capture, availability, source events and shutdown.
`OwnedScreenCapture` owns one persistent backend and admits one capture at a time.
Frames contain acquisition time, capture ID, source generation and identity, dimensions, app/window metadata, encoded bytes and local samples.
Source changes revoke pending leases. Independent transferred buffers are zeroed after use, rejection, cancellation or late completion.
Raw images are never written by product code.
The production native backend remains an integration choice. The contract and service work with replaceable backends.

## C. Privacy gate

States: ALLOW, BLOCK, LIMITED and UNKNOWN.
Automatic vision fails closed when any safety signal is unknown.
Application exclusions, window exclusions, private contexts, lock state, sensitive context and pause block uploads.
LIMITED is capture-only. No redactor sends an original frame.
Manual unknown authorization applies to one request and cannot override an explicit block.
Policy revisions are checked before attempts, after responses and before state commits.
Throwing subscribers cannot prevent privacy or source revocation.

## D. Change detector

The detector uses a 64 by 36 luminance grid, SHA-256 duplicate signature and source identity.
The sampler visits 9216 pixels regardless of raster size.
Meaningful thresholds: mean difference at least 12, or 8% of cells differ by at least 32.
Major thresholds: mean difference at least 70, 60% changed cells, or source identity changes.
Tests cover identical frames, cursor-sized changes, localized UI/text changes, major scenes and app/window/display changes.
Small changes between sampling points or equal-luminance colors can be missed. This is not full OCR or exact image equality.

## E. Scheduler

Defaults: 1000 ms capture interval, 500 ms debounce and 20000 ms ambient minimum interval.
Idle refresh is disabled by default. An explicit maximum refresh interval is supported.
Manual requests bypass ambient cooldown and debounce while retaining privacy and provider backoff.
Duplicate screens do not cause repeated VLM calls.
Event output also suppresses duplicate awareness states.

## F. Vision schema and adapters

`VisionObservationPort` exposes capabilities and locality. Models are configured, not named by architecture.
LOCAL uses explicitly configured local vision. CLOUD and CLOUD plus Mura voice use cloud only.
HYBRID tries cloud first and permits local fallback only with an explicit flag and configured adapter.
No model process starts automatically. There is no FastVLM default or fallback.

The OpenAI-compatible adapter supports strict JSON Schema or JSON-object output.
The prompt requests literal facts, treats screen text as untrusted data and disables tools.
The schema bounds scene, activity, summary, text, objects, people count, warnings and generic media hints.
Malformed or excessive output cannot enter world state. Provider response bodies never enter errors or logs.
Strict schemas require a nullable people count. Validation converts null into an absent count.

## G. World state and TTL

Queries distinguish fresh, stale, unavailable, privacy-blocked, capture-failed and VLM-failed states.
Only fresh results expose observation facts. The default TTL is 15000 ms from frame acquisition.
Unchanged local samples do not extend the original TTL.
Changed frames hide older facts during inference while retaining one comparison for conservative fusion.
One missing object remains uncertain for one observation. App or window changes clear that uncertainty.
Low confidence removes detailed text, objects, people count and media facts.

## H. Race and staleness protection

Request epochs, source generations, policy revisions, acquisition timestamps and deadlines reject stale completions.
Older captures and observations cannot overwrite newer state.
Hard invalidation resets the accepted signature so static screens can recover after privacy blocks or failure.
A reversion during cooldown restores older facts only within their original TTL.
At most two underlying vision promises remain admitted, including an uncooperative superseded adapter.
Per-adapter attempt deadlines permit fallback within the total request budget.
Per-adapter 429 backoff survives successful hybrid fallback. Numeric and date-form Retry-After values are supported.

## I. Manual look_now

`PerceptionService.look_now()` requests a fresh capture, checks privacy, invokes configured vision and returns a fresh bounded observation or explicit failure state.
It supports cancellation and request-scoped unknown authorization.
No MCP registration or runtime assembly change was made.

## J. Live vision evidence

The existing protected Gemini configuration supplied `gemini-3.1-flash-lite`.
Two complete passes returned six fresh observations each.
One intermediate pass timed out on its first attempt. Backoff prevented further uploads during that pass.
There were 13 cloud attempts across these deliberate validation runs, including the timeout.

Final pass:

| Generated reference scene | Scene category correct | Seeded text useful | Checked hallucinations | Pipeline time |
| --- | --- | --- | --- | --- |
| Code editor | Yes | Yes | 0 | 4.72 s |
| Browser recipe page | Yes | Yes | 0 | 4.55 s |
| Terminal | Yes | Yes | 0 | 5.57 s |
| Illustrated paused video | Yes | Yes | 0 | 2.88 s |
| Desktop | Yes | Yes | 0 | 4.57 s |
| Changed window: network settings | Yes | Yes | 0 | 4.87 s |

Hallucination checks cover invented brands, invented people and contradictions of the visible paused state.
Zero of six observations violated those checks. Other hallucination types were not systematically scored.
Three further captures of the same reference scene added zero cloud calls.
Average successful vision latency was 4.23 s. Rendering and pipeline time averaged 4.53 s.
The final evaluator used 11000 ms attempt and 12000 ms total vision limits.

These are live provider calls on controlled generated fixtures, not screenshots of real application sessions or anime episodes.
They do not establish broad VLM accuracy. No uncontrolled desktop or sensitive scene content was uploaded.
Credentials were used only for provider authentication.
Images and VLM prose were not persisted in diagnostic output.

## K. Performance and resources

| Measurement | Result | Scope |
| --- | --- | --- |
| Native acquisition, scale and JPEG encode | p50 18.1864 ms, p95 22.1999 ms | 15 samples after five warmups, local Windows spike |
| Native captured region | 1463 by 914 | Reported by System.Drawing, production DPI behavior not validated |
| 1080p luminance sampling | p50 0.0675 ms, p95 0.1051 ms | 1000 measured iterations |
| Change detection | p50 0.0082 ms, p95 0.0101 ms | 2304 cells, 1000 measured iterations |
| Static scheduler workload | 10 captures, one stub vision call, nine duplicates | 10.10 s real elapsed time |
| Idle CPU | 125 ms, about 1.24% of one core | Short process measurement, includes runtime overhead |
| RSS | 92.9 MiB start, 88.5 MiB end | Node plus TSX process |
| Heap | 9.34 MiB start, 9.84 MiB end | Short measurement, not a soak test |
| Live static captures | Three duplicates, zero added cloud calls | Final live provider pass |

The native spike saved and uploaded no images. It is not the integrated capture backend.
GPU usage was not measured. The local change path launches no GPU inference or local model.
Long-running native capture CPU, memory, GPU impact and real-app accuracy remain integration validation work.

## L. Tests and review

Baseline: 401 existing tests passed.
Final affected workspace: 457 tests passed in 26 files, including 56 R5 tests.

Commands:

```text
cd services/companion-core
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc --noEmit

cd ../..
node node_modules/eslint/bin/eslint.js services/companion-core/src/perception services/companion-core/test/perception services/companion-core/eval/perception
git diff --cached --check
```

All four affected checks passed. Targeted ESLint reported no errors or warnings.
Tests cover cancellation, stale frames, source loss, privacy changes during capture and vision, malformed output, timeout, 429, 500 and shutdown.
They also cover low confidence, TTL expiry, manual requests, idle refresh, cooldown, out-of-order completion, fallback backoff and subscriber failures.

An independent Superpowers code review reproduced the lifecycle and transport defects.
Every concrete finding received a regression test and a fix.
Review process: [requesting-code-review skill](C:/Users/Rikon/.codex/plugins/cache/openai-curated-remote/superpowers/6.4.2/skills/requesting-code-review/SKILL.md).

Broader repository checks:

- `pnpm lint`: zero ESLint errors, 679 warnings across 331 files. The repository warning limit caused a nonzero exit.
- An earlier filtered install lacked `@radix-ui/colors`. Installing the existing workspace dependencies resolved that dependency error.
- `pnpm typecheck`: 46 successful tasks, including Companion Core. Stage UI failed with 755 diagnostics, including 174 missing-module errors.
- Missing workspace exports include electron-screen-capture, server-sdk, core-agent and i18n. The Stage UI and Stage Pages source diff against the base is empty.
- No changes to unrelated Stage or package source were made to hide those failures.

## M. Files and commits

The foundation commit is `caf56ebb898fe96f119c89ee785b7aa23109745d`.
Its 23 new files contain 2207 lines across the isolated perception modules, tests, README and evaluation helpers.
This report is committed separately as validation evidence.

Production modules are under `services/companion-core/src/perception`:
capture, privacy, change-detection, observations, world-state, vision, scheduler, ports, service and index.
Tests are under `test/perception`. Measurements and controlled live validation are under `eval/perception`.
Planning and local native measurement evidence remain under `D:\AI\.planning\r5-perception-codex`.

## N. R2B plus R3 integration seam

Runtime assembly can import `src/perception/index` and create one service with one persistent capture backend.
Connect existing profile configuration, capability routing, quotas, budgets, consent, indicator, pause and shutdown there.
The isolated direct adapter does not replace production quota accounting.
Expose fresh facts through a bounded untrusted-data NOW block. Register MCP look_now later.
Server, run.ts, provider router, quota, profile, AIRI Stage, chat, hearing and speech files are unchanged.
Exact integration notes: `D:\AI\.planning\r5-perception-codex\integration_notes.md`.

## O. R4 memory seam

`PerceptionEventPort` publishes bounded current-world transitions without image bytes.
R5 imports no R4 implementation and opens no memory database.
R4 decides which rare observations deserve durable storage. Routine screen facts remain current state.
Selected memories need their own policy, acquisition time, confidence, provenance and observation ID.

## P. R6 Watch Together seam

Fresh media detection, title-like text, playback-like state and subtitle-like text form the generic output boundary.
R5 contains no AniList, episode tracking, browser-extension subtitle ingestion, system audio, transcription, or spoiler policy.
R6 was not started.

## Q. Remaining blockers and limits

No R5 foundation blocker remains against the parallel task's acceptance criteria.
Native backend wiring, runtime lifecycle, capture indicator and consent, gateway context and MCP registration are deferred integration work.
Broader repository lint and Stage UI typecheck are not green, as reported above.
Real application, anime, long-running native resource and broader hallucination evaluation remain unvalidated.
The sampled detector can miss small changes. Stuck adapters can reduce availability, but retained work remains bounded.

R5 FOUNDATION READY — WAITING FOR INTEGRATION
