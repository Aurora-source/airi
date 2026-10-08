# Vivid visual presence review

Branch: `codex/visual-presence-vivid`. Exact foundation: `67156ab9ca204f0c7bc0648ab8d352404d4fe05d`.
Worktree: `D:\AI\airi-visual-presence-vivid`. This branch is intended for review and has not been merged.

## A. Why the foundation appeared rigid

The foundation bound head and spine rotations with small amplitudes. Shoulders, arms, forearms, and wrists never participated. Similar envelopes made different behavior labels share a small head movement. The native expression row deliberately tested facial channels alone, so selecting happy there could not produce body language.

## B. Body channels

The adapter now discovers 14 normalized humanoid bones: hips, spine, chest, upper chest, neck, head, both shoulders, upper arms, forearms, and hands. Each has pitch, yaw, and roll channels. There are 42 bounded rotation channels plus existing gaze/breath channels. Missing bones are skipped. The controller's required native frame fields remain compatible; added body fields are optional.

## C. Arms and hands

Upper-arm opening, mirrored elbow flexion, and restrained wrist rotations accompany the torso. Delayed wrist settling and asymmetric arm adjustments add life without constant arm movement. The conventional elbow hinge guard prevents our offset from extending beyond a straight sampled elbow, while unusual authored elbow orientations remain under the mixer. Fingers remain untouched; the improvement comes from shoulder, forearm, and wrist coordination.

## D. Reusable gesture primitives

Twenty reusable primitives drive the catalog: chest-open, chest-collapse, shoulder-lift, shoulder-drop, open-arms-small, hands-inward, lean-forward, lean-back, lean-side, recoil, small-shrug, thoughtful-hand, attentive-posture, excited-lift, relaxed-drop, concerned-fold, subtle-hand-fidget, asymmetric-arm-shift, torso-turn, and stretch-open.

The existing retargetable idle VRMA remains in use. The local corpus has no embedded clips, and the repository provides no quality/licensed gesture set suitable for this pass. No third-party gesture assets were added. Existing optional authored-motion roles retain their procedural fallback.

## E. Existing behavior vocabulary

No new product-facing behavior names were added.

| Behavior | Body language |
| --- | --- |
| gaze-drift | Very small head/eye wandering with delayed torso follow |
| head-drift | Multi-stage head path with chest counter-motion |
| breath-shift | Distributed chest opening and delayed shoulder relaxation |
| posture-shift | Weight redistribution, torso twist, and asymmetric arm settling |
| glance-left / glance-right | Eyes/head lead; torso and relaxed arm follow |
| look-up / look-down | Neck and chest support the head direction |
| head-tilt | Social tilt, shoulder asymmetry, and opposing torso lean |
| tiny-smile | Small chest/head lift and restrained shoulder/arm opening |
| curious | Inquisitive tilt, forward lean, partial shrug, asymmetric hand response |
| fidget | Uneven wrist/forearm actions with a small posture adjustment |
| attentive | Faster balanced straightening, chest opening, settled arms |
| listening | Softer forward lean, head tilt, relaxed arm/wrist adjustment |
| nod | Anticipation, coupled neck/head acceleration, chest response, second smaller nod |
| stretch | Long extension and chest opening with clearly wider arms, then release |
| relaxed | Dropped shoulders, softened chest, loose wrists, slow lean |
| sleepy | Lowered head and collapsed chest with delayed heavy settling |
| look-around | Head/torso scan with brief holds and direction changes |
| thoughtful | Slow opposing head/torso angles and a restrained asymmetric forearm |
| restless | More frequent weight/twist/wrist adjustments with uneven timing |
| settle | Dropped shoulders/arms followed by a final small torso adjustment |
| thinking | Stronger asymmetric forearm/hand stance, offset gaze, opposite torso angle |
| waiting | Calm weight drift and delayed arm settling |
| happy | Open chest, lifted/open shoulders, asymmetric arms and hands |
| amused | Restrained torso/shoulder bounce, slight head turn, smaller hand reaction |
| concerned | Forward collapse, inward shoulder orientation, restrained forearms, tilt |
| frown | Firmer downward posture with shoulder/arm tension |
| surprised | Fast recoil and overshoot, shoulder/arm response, delayed hands, softened return |
| focused | Balanced forward posture and quiet settled arms |

## F. Timing and secondary motion

Nine sparse smoothstep curves provide soft, quick, reaction, nod, drift, scan, fidget, stretch, and settle timing. Surprise starts in roughly 120 ms and overshoots before softening; stretch builds over seconds; scan has holds; nod and amused use rhythmic reversal. Bone groups have different delays: torso/head lead depends on the behavior, shoulders follow, then upper arms, forearms, and wrists. Individual gestures can add further delays. All curves include neutral endpoints. Replacement blends the outgoing pose into the next onset; cancellation recovers over 450 ms.

## G. Asymmetry and idle life

Primitives use intentionally unequal sides, opposing torso/head angles, and small fixed per-behavior variation from the injectable random source. Variation is sampled once, so no per-frame randomness or twitching occurs. Scheduling preserves long calm periods. Optional procedural micro life includes tiny chest, hips, spine, and shoulder motion when the host does not own native pose micro motion. AIRI's existing native idle retains that ownership by default.

## H. Primary-avatar tuning

The primary local avatar was the subjective acceptance target. Initial held-timeline review exposed VRM0 arm offsets folding inward. Installed `three-vrm-animation` source confirmed canonical quaternion X/Z conversion; the adapter now performs the same conversion. A deterministic VRM0/VRM1 regression protects it.

After correction, two complete primary passes captured 18%, 42%, and 77% of each behavior: 180 active-pose screenshots total, with 60 neutral restorations and no page errors. All six contact sheets from each corrected pass were visually inspected. Stretch, surprise, and happy now open the arms outward; thinking uses one arm more strongly; relaxed, sleepy, concern, listening, and focused retain quieter distinct postures. Defaults remain generic and capability-driven. No filename checks or avatar edits were added.

## I. Six-model compatibility

All six models passed four runtime passes, each exercising all 30 behaviors at 12 advancing rendered samples: 8,640 samples total. Every affected bone restored its expected sampled mixer base at natural completion, without forced cleanup between samples. All scene transforms stayed finite, expressions returned to their initial weights, and disposed controllers stayed inert. ACT, speaking, manual cancellation, model switching, and unmount checks passed with zero page errors.

| Local model | Bones | Passed runs | Peak model extent ratio |
| --- | --- | --- | --- |
| 108663257250472601 | 54 | 4 × 30 behaviors | 1.0074 |
| 2304491456352929717 (primary) | 54 | 4 × 30 behaviors | 1.0196 |
| 7931905149146643613 | 54 | 4 × 30 behaviors | 1.0072 |
| 8168400654368128337 | 54 | 4 × 30 behaviors | 1.0182 |
| 9082311462727886848 | 54 | 4 × 30 behaviors | 1.0145 |
| Columbina VRM,Vroid by MikelX3D | 53 | 4 × 30 behaviors | 1.0055 |

Peak per-bone additive angle was 0.527706 rad, below the 0.85 rad diagnostic threshold. Same-model GPU geometry/texture counts remained identical across runs. After warmup, listeners stayed 174 and DOM nodes stayed 395. Post-GC JS heap rose from 13,658,744 to 14,170,944 bytes (about 3.75%), within the 10% plus 1 MB regression bound. These repeated-run measurements establish bounded resources, not a proof of zero lifetime leaks.

## J. Raw versus embodied gallery

`RAW NATIVE EXPRESSIONS` still sets only the selected native channel. Blink and mouth presets never request body gestures. `EMBODIED EMOTIONS` maps eight emotional previews to existing catalog behaviors. All 30 catalog buttons remain below. Developer controls expose body, arm, hand amplitude and transition speed; a body OFF/ON checkbox provides comparison without a legacy production driver.

Primary runtime controls verified body OFF/ON, and pure raw blink, aa, ih, ou, ee, and oh previews. Each raw preview left every procedural pose channel zero. The OFF/ON captures show the same face/head with a clear difference in chest, shoulders, arms, and hands. No browser errors occurred.

## K. Range and clipping protections

Each channel is finite-checked, capability-filtered, and clamped in the controller and adapter. Recovery and amplitude changes use the same checks. Additive maximums in radians are:

| Bone group | Pitch / yaw / roll |
| --- | --- |
| Hips | 0.025 / 0.035 / 0.025 |
| Spine | 0.09 / 0.10 / 0.08 |
| Chest | 0.12 / 0.12 / 0.085 |
| Upper chest | 0.085 / 0.08 / 0.07 |
| Neck | 0.10 / 0.16 / 0.10 |
| Head | 0.22 / 0.36 / 0.19 |
| Shoulders | 0.10 / 0.14 / 0.15 |
| Upper arms | 0.16 / 0.26 / 0.38 |
| Forearms | 0.08 / 0.65 / 0.08 |
| Wrists | 0.14 / 0.16 / 0.18 |

The corpus additionally checks finite scene transforms and proportional model extent. Primary screenshots show no catastrophic crossing or extreme wrist poses. Loose sleeves obscure elbow detail. These are bounded rotations, not mesh collision solving; minor clothing intersections can vary by rig and clothing.

## L. Ownership and regressions

Speaking, ACT, explicit model motion, and manual control immediately release procedural ownership. The adapter restores only a transform/value that still equals its own last write; a newer mixer/manual write wins. Expression flushing stays in the existing phase after ACT/lip sync. Mouth, blink, scale, position, eye bones, and spring bones remain untouched. Larger body gestures feed the existing humanoid/spring update through the same runtime hook.

## M. Performance

Tracks compile once per controller. Updates sample numeric tracks into a reused frame; the adapter reuses Euler/quaternion objects. There is no second renderer, IK, physics replacement, timer-driven animation, or network call.

Primary Chromium measurements wait for a full 120-frame bucket with the requested held behavior still active. Mean pose-hook cost was 0.0892 ms for stretch, 0.0883 ms for thinking, 0.0875 ms for happy, and 0.1342 ms for surprise. This includes gallery owner synchronization and pose sampling/application. It excludes the separately scheduled expression flush and diagnostics outside that hook. Measurement used the local headless software-rendering environment while corpus validation was also running; it is a conservative local CPU measurement rather than a GPU frame-rate benchmark. All samples were below the 0.5 ms diagnostic threshold.

## N. Tests and checks

- Visual driver: 52 deterministic tests passed, including torso/shoulder/arm/wrist participation, bounds, delayed motion, shape timing, asymmetry, interruption, recovery, repeated/replaced behavior, authored-base restoration, missing bones, model switching, finite custom catalogs, and VRM0 conversion.
- Existing renderer regression: 28 tests passed.
- Package, gallery, renderer, and root workspace typechecks passed.
- Scoped source lint passed. Production and review gallery builds passed; existing scrollbar utility and bundle-size warnings remain.
- Independent focused source review found no remaining blockers after regression-backed fixes.
- Root lint passed on the raw rerun with zero errors and existing warnings. A prior zero-error run ended with a Windows native-process crash; the raw rerun exited successfully.

## O. Visual and runtime evidence

Local evidence is outside Git at `D:\AI\vivid-evidence`. `primary-held-2` and `primary-held-3` contain the corrected captures, JSON, HTML, and six sheets each. `corpus-vivid` contains the 24 six-model visual captures and six reviewed sheets. `corpus-restoration-final/corpus-runtime.json` contains the successful four-pass natural-end regression and resource evidence. `controls-vivid-final` contains body OFF/ON, raw-channel purity, and full-bucket timing evidence. Earlier real-time captures that missed active poses were rejected. Held review poses sample the actual controller and adapter after the real animation mixer; they do not introduce a separate pose implementation. The corpus runs advancing behaviors on real render ticks and validates springs/neutral restoration.

Playwright MCP could not launch because its configured Chrome executable is absent. The existing package's Playwright Chromium 151.0.7922.34 performed local gallery validation instead. No browser dependency was added to the repository.

## P. Files and commits

Implementation commit: `dc7fb462c3770fe803a5feaa9f9aed6f1ccb0b27` — `feat(visual): add vivid embodied behavior motion`. A documentation closure records the completed validation and delivery.

Runtime changes are scoped to `packages/model-driver-visual/src`: contracts, motion primitives/sampling, catalog, controller, VRM adapter, and optional Live2D frame reads. Tests extend controller/VRM coverage and add `embodied.test.ts`. Gallery/probe and local browser tools provide review controls and stronger corpus checks. README, this report, and the four planning files plus visual-review notes preserve decisions and evidence. No renderer architecture, project instructions, dependencies, lockfile, VRM assets, or integration worktrees were changed.

## Q. Final SHA

The implementation SHA is `dc7fb462c3770fe803a5feaa9f9aed6f1ccb0b27`. The final pushed branch SHA, including the documentation closure, is recorded in `D:\AI\vivid-evidence\FINAL_REPORT.md` after remote verification.

## R. Integration

Review `origin/codex/visual-presence-vivid` relative to the exact foundation commit. Apply the reviewed commit to an integration branch only after user review; this task does not merge it.

R6/R7 continue calling `playVisualBehavior`, `setIdleIntensity`, `setVisualActivity`, `cancelBehavior`, and `returnToNeutral`. No bone knowledge is required. Keep passing all external owner flags before `update`, sample the visual pose after base animation, flush expressions after ACT/lip sync, release before model disposal, and remove hooks on unmount. Optional rig presentation settings belong in host configuration through `tuning`/`setMotionTuning`; defaults need no model profile.

To review locally, run `pnpm -F @proj-airi/model-driver-visual demo`, choose the user's local VRM files, compare body OFF/ON, and use the existing behavior catalog. Avatars stay local. The browser tools accept explicit evidence directories and localhost URLs.
