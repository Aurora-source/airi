# Visual presence foundation report

Branch: `codex/visual-presence`. Worktree: `D:\AI\airi-visual-presence`. Base: verified upstream/main `45b8670e63f93debe7000453832b0611a66a5129`. No integration worktree edits or merges.

## A. Upstream avatar architecture

Live2D belongs to `stage-ui-live2d`. Pixi/Cubism loads models and motions. `useLive2DMotionManagerUpdate` provides pre, post, and final plugins. Existing expression, blink, gaze, universal idle, manual springs, beat sync, breathing, and mouth plugins already coordinate the final pass. Model initialization discovers parameters and expression definitions. Motion groups and model settings remain upstream-owned.

VRM belongs to `stage-ui-three`. `ThreeScene` owns the renderer and `VRMModel` owns the managed instance and render update. Existing GLTF/VRM loaders, normalized humanoid bones, VRMA retargeting, `AnimationMixer`, look-at, blink, eye saccades, lip sync, ACT emote, node constraints, spring bones, material updates, and resource cleanup remain in use. The existing runtime pose hook runs after the mixer and before humanoid update. No second avatar renderer or Stage implementation exists in this branch.

## B. Existing behaviors reused

Native blink, eye tracking, breath/base idle, model physics, ACT, mouth sampling, expression managers, and the existing `idle_loop.vrma` remain the base layer. Native micro channels are declared in adapter capabilities, so the scheduler does not replace them with another continuous oscillator. Explicit procedural head/body offsets add to the sampled base pose and remove only values still owned by this layer.

## C. New behavior catalog

Thirty data entries carry duration, cooldown, weight, compatible pose channels, optional expression, optional semantic native-motion role, and idle eligibility.

| Category | Entries |
| --- | --- |
| Micro | gaze-drift, head-drift, breath-shift |
| Short | posture-shift, glance-left, glance-right, look-up, look-down, head-tilt, tiny-smile, curious, fidget |
| Listening | attentive, listening, nod |
| Long | stretch, relaxed, sleepy, look-around, thoughtful, restless, settle |
| Thinking / waiting | thinking, waiting |
| Positive | happy, amused |
| Concerned | concerned, frown |
| Surprise / watching | surprised, focused |

`stretch` and `sleepy` request native stretch/yawn roles only when explicitly bound. Their fallback is a small pose, not a claim that the model performs a full stretch or yawn. Watch-together requests use the same silent reaction primitives.

## D. Idle scheduler

The controller runs from existing render ticks. It installs no timer, listener, network request, or background loop. Scheduling uses bounded random intervals, weighted eligible entries, per-entry cooldowns, a three-entry previous-motion history, expression spacing of at least 120 seconds, and minimum neutral periods. Long idle requires at least 120 seconds of continuous eligible idle and has at least 180 seconds between admissions. All state stays local to one model/controller.

| Level | Interval | Amplitude | Long-idle admission probability | Neutral period |
| --- | --- | --- | --- | --- |
| still | disabled | 0 | 0 | 15 s |
| calm | 50–100 s | 0.35 | 0.025 | 16 s |
| normal | 25–65 s | 0.55 | 0.06 | 12 s |
| lively | 15–40 s | 0.75 | 0.10 | 9 s |

Still disables added idle only. Upstream blink/breath/base idle retain their configured behavior. Listening admits a brief attentive pose on state onset and sparse nods. Thinking and waiting start only when the host explicitly selects those activities.

## E. Priority and interruption

Speaking/lip-sync, ACT, explicit model motion, and user actions immediately release lower ownership. Listening uses priority 60, explicit visual requests 40, long idle 20, and micro/short idle 10. Lower requests are blocked during listening. Explicit requests replace idle. Cancellation and return-to-neutral blend over 450 ms. External owners use immediate release so they retain the next write. Model switches reset handles, cooldowns, and recent-motion state.

## F. Live2D behavior

The adapter imports the actual upstream Cubism type. Capability discovery reads real IDs and ranges, avoiding Cubism's synthetic unknown-parameter indices. Model configuration supplies semantic axes, units, and expression bindings. Writes clamp to actual ranges. Stored Float32 values determine ownership, preventing accumulated offsets from rounding differences. Existing expression APIs remain the writer. Native blink, gaze, breath, physics, and mouth channels retain upstream ownership.

The adapter and float-storage behavior are verified by focused fixtures. No local Live2D model was supplied for real rendered validation. Production binding is intentionally left to the documented existing motion-plugin seam.

## G. VRM behavior and compatibility matrix

The adapter discovers normalized head or neck and spine or chest by VRM humanoid semantics. It uses bounded additive quaternion rotation without writing positions, scale, eye bones, mouth, arms, or secondary motion. No model names, bone indices, parameter names, or body proportions are hardcoded in the runtime.

All six read-only local files were inventoried. Each has mapped head/neck/spine/chest, left/right eyes, arms, hands, and fingers, bone look-at, blink plus left/right blink, and all five mouth vowel presets. Existing secondary motion remains active.

| Local file | VRM | Humanoid bones | Upper chest | Spring groups / collider groups | Native look morphs | Native clips |
| --- | --- | --- | --- | --- | --- | --- |
| 108663257250472601.vrm | 0.0 | 54 | yes | 12 / 12 | up/down/left/right | none |
| 2304491456352929717.vrm | 0.0 | 54 | yes | 15 / 12 | absent, bone look-at present | none |
| 7931905149146643613.vrm | 0.0 | 54 | yes | 20 / 12 | absent, bone look-at present | none |
| 8168400654368128337.vrm | 0.0 | 54 | yes | 13 / 10 | absent, bone look-at present | none |
| 9082311462727886848.vrm | 0.0 | 54 | yes | 11 / 12 | up/down/left/right | none |
| Columbina VRM,Vroid by MikelX3D.vrm | 0.0 | 53 | absent | 4 / 3 | up/down/left/right | none |

All have neutral, joy, fun, sorrow, angry, blink, and vowel blendshape groups. Neutral on Columbina has no binds. Five models have one custom unknown expression, and Columbina has two. The driver assigns no invented meaning to custom expressions. `three-vrm` converts VRM0 joy/fun/sorrow to canonical happy/relaxed/sad, and a/i/u/e/o to aa/ih/ou/ee/oh. No real model exposes canonical surprised or sleepy.

Unit-scale transforms are explicit on the second file and implicit on the others. Runtime world bounds measure actual scale instead of assuming proportions. Initial loaded bounds (X × Y × Z, scene units) were 1.190 × 1.534 × 0.567, 1.271 × 1.520 × 0.361, 1.297 × 1.559 × 0.532, 1.190 × 1.533 × 0.369, 1.190 × 1.533 × 0.403, and 1.434 × 1.676 × 0.768 respectively. These include clothing, hair, and sampled pose, rather than a fixed anatomical height.

None contains embedded glTF animations or VRMC_animation. Upstream `createVRMAnimationClip` retargets the existing separate idle clip to each humanoid. No new clip or model-specific tuning is required. Full node-to-humanoid mappings, blendshape names/bind counts, look-at curves, scales, local bounds, and SHA256 hashes are preserved in the external read-only inventory at `D:\AI\.planning\visual-presence-codex\corpus-inventory.json`.

The real corpus contains VRM0 only. VRM1 normalized-bone/expression semantics are covered by adapter tests, not by a claim of real VRM1 corpus coverage. Loader conversion owns the VRM0 coordinate and preset differences. The visual controller is version-independent.

## H. Capability fallback

All 30 catalog entries have a compatible expression or head/body fallback on every corpus model, confirmed in all four rendered passes. Happy/amused use happy plus pose, concerned/frown use sad plus pose, relaxed uses relaxed plus pose. Surprise and sleepy use pose only. Gaze entries preserve native eye tracking and fall back to head rotation where no explicitly bound gaze axis exists. Breath variation preserves the existing idle clip and adds only a subtle posture primitive. Stretch/yawn native roles are absent on the corpus and use smaller bounded poses. All six models use continuous rather than binary expressions.

Expression-only, bone-only, absent optional motions/expressions, failed optional native-motion playback, and wholly unsupported models have deterministic tests. A model without any suitable capability stays neutral and returns `unsupported`. This driver never edits a user's VRM.

## I. R6 seam

`VisualBehaviorPort.playVisualBehavior` accepts silent requests such as amused, surprised, concerned, and focused. R6 retains its deterministic reaction admission. This branch imports no R6 code and changes no Watch Together policy.

## J. R7 seam

The port exposes explicit behavior requests, idle intensity, visual activity, cancellation, neutral return, and owner flags. A future R7 supplies its own mood, attention, activity, and reaction choices. No Director, autonomous thoughts, memory decisions, salience reasoning, or proactive speech exists here.

## K. Performance

The core reuses its frame object and the VRM adapter reuses quaternion/Euler scratch storage. Idle selection builds candidates only when making a scheduling decision. No per-frame pose object or scratch quaternion is allocated, and no controller timer is installed. GPU rendering stays in the existing renderer and materials. The switching stress harness reduces canvas height to 128 px after capturing the normal 400 px gallery screenshot, to reduce headless software rasterization cost.

Chromium 151.0.7922.34 measured the gallery's visual pose pass at 0.0258 ms/frame in the final sample. Earlier normal-height samples were approximately 0.02–0.04 ms/frame. This measures the added pose hook, not the entire renderer, hardware GPU time, or model loading. No separate GPU timing claim is made.

After two warmup passes and two more passes, the same final model retained 150 event listeners and 356 DOM nodes in both CDP snapshots. Post-GC JS heap changed from 34,239,408 to 34,447,496 bytes, a bounded increase of 208,088 bytes (0.61%). This finite run demonstrates stable listeners/nodes and bounded heap, not a proof of unlimited-duration resource stability.

| Model in matrix order | Geometries | Textures | All four passes |
| --- | --- | --- | --- |
| 1 | 25 | 34 | stable |
| 2 | 23 | 35 | stable |
| 3 | 37 | 62 | stable |
| 4 | 25 | 34 | stable |
| 5 | 25 | 34 | stable |
| 6 | 36 | 22 | stable |

## L. Automated tests

Twenty-seven focused tests pass: start/stop, speaking/ACT/manual/motion ownership, explicit interruption, listening priority, neutral return, cooldowns, repetition avoidance, sparse seeded scheduling, missing motion/expression fallback, unsupported models, optional asset failure, owned motion cancellation, model switches, rapid changes, disposal, timer absence, intensity behavior, amplitude limits, Float32 ownership, external-write preservation, VRM0/VRM1 semantics, and deferred expression flushing.

Twenty-eight existing renderer tests pass. Package, gallery, affected renderer, and root workspace typechecks pass. Root Turbo reports 56 successful tasks across 62 packages in scope. Targeted raw package source lint passes. The renderer files retain five existing warnings and have zero lint errors. The gallery production build passes, with existing upstream scrollbar utility warnings and the expected bundled-renderer size warning. No generated build files are committed.

## M. Manual demo and model-switch exercise

The isolated localhost gallery accepts all six local files, offers all catalog entries and discovered native expressions, the existing native idle clip, four intensity levels, activity settings, speaking/manual owner controls, actual ACT interruption, cancellation, and a three-minute idle demonstration. It uses one upstream renderer across switches.

The corpus exercise loads each model, samples all 30 behaviors on six real render ticks each, exercises all intensity profiles with a deterministic clock, checks released expression weights, disposes the controller, and verifies that later updates do not access the old skeleton. Two passes are available with one button. The Chromium harness repeats that exercise and compares the same final model after garbage collection. It also checks preview cleanup, ACT/speech admission, mid-exercise manual cancellation, and no restart from a canceled run.

A focused review reproduced and resolved Cubism Float32 accumulation, expression-preview baseline leakage, and dev-corpus owner bypass. All three have regression evidence. The final targeted review found no remaining Critical or Important issue.

Final live result: all six avatars, four passes, 24 complete model loads, 30 compatible behaviors per model, and 4,320 actual rendered behavior samples. Every row passed expression-baseline restoration and disposed-controller safety. Same-model GPU counts remained unchanged. Actual native ACT and supplied speaking ownership blocked requests. Native preview restored zero after the visual owner released. Mid-corpus manual control canceled the exercise without restarting idle. Detaching the renderer stopped frame callbacks. No uncaught page errors occurred. SHA256 comparison confirmed all six input files unchanged.

Evidence: `D:\AI\.planning\visual-presence-codex\live-evidence\corpus-runtime.json`, `corpus-exercise.json`, and `gallery.png`. Full-size screenshots were visually inspected. These local artifacts and avatar assets stay outside Git.

## N. Files changed

- `packages/model-driver-visual`: contracts, catalog, controller, Live2D/VRM adapters, exports, three focused test files, package/config files, README, local gallery/probe, read-only inventory tool, and Chromium corpus harness
- `packages/stage-ui-three`: two optional renderer callback seams and shared callback types/barrel
- Root `vitest.config.ts`: register the new package
- `pnpm-lock.yaml`: new workspace importer only
- This report and `docs/visual-presence-integration.md`

No avatar assets, raw media, integration runtime files, AGENTS.md, CLAUDE.md, or new animation clips are changed or committed.

## O. Upstream divergence

Only a small generic optional VRM expression-phase hook and owner/source context extend upstream renderer files. Existing callbacks remain compatible. This is an isolated upstream PR candidate, documented separately from the behavior package. Live2D uses its existing plugin architecture with no renderer patch. Stage stays unchanged.

## P. Commits and final SHA

The branch is committed and pushed after final evidence checks. The final SHA is supplied in the completion response and external task progress record, avoiding a self-referential commit hash in this file. No merge is performed.

## Q. Integration instructions

See [visual-presence-integration.md](visual-presence-integration.md) for frame phases, owner flags, model lifecycle, Live2D bindings, R6/R7 ports, and the upstream seam candidate. Runtime adoption is a separate integration step. Use the existing renderer update rather than adding timers or another renderer.
