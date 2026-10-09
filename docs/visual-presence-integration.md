# Visual presence integration

Branch: `codex/visual-presence`. Base: upstream `45b8670e63f93debe7000453832b0611a66a5129`. Avatar and lip-sync packages matched the integrated foundation at branch creation. This branch does not wire into Stage or any integration runtime.

Status: wired into the real Stage on `integration/r6-media-visual-r7` through `VisualPresenceHost` (`packages/stage-ui/src/libs/visual-presence`). The VRM frame context there reports lip sync from active visemes only. See [the combined runtime](r6-r7-combined-integration.md).

## Runtime ownership

Create one controller for the visible avatar. The host selects idle intensity and visual activity and supplies current speaking, ACT, explicit-motion, and manual-control flags before updates. Speaking and explicit ACT always win. Listening has priority 60, explicit visual requests 40, long idle 20, and micro/short idle 10. The host releases ownership before model disposal and removes callbacks on unmount.

For VRM, use the existing `ThreeScene.setVrmFrameHook`. The callback runs after mixer sampling and before humanoid update. The optional generic `setVrmExpressionFrameHook` runs after upstream blink, lip sync, and ACT sampling, before expression-manager update. Create the adapter with `deferExpressions: true` and flush it in this second callback. Recheck owner flags in both phases. Combine ACT/lip-sync flags from the frame context with explicit-motion and user-action flags from the host.

The callback context is reused and read-only. `modelSrc` identifies the committed instance while its replacement loads. Ignore frames for a pending source. Release the old adapter before requesting a replacement. On the replacement's first matching frame, discover capabilities again and attach a fresh adapter. The controller owns its adapter, but upstream owns the model, skeleton, mixer, and GPU resources.

For Live2D, attach to `useLive2DMotionManagerUpdate` with its existing post/final plugin registration. Its internal phases currently live inside model initialization. A future runtime integration passes a plugin through that initialization seam or registers it there with a small generic prop. No second update loop is needed. Use the real Cubism table and model configuration to bind semantic axes, units, and expression meanings. Apply pose after normal motion sampling, release for higher owners before their writes, and route expressions through `useExpressionController`/the existing expression store. Do not write eye, mouth, or breath channels that an upstream controller owns. Keep `nativeMicro` truthful for each configured model.

Native motion bindings carry a semantic role and a duration. The host supplies a playback function returning a handle that stops only the requested motion. Its cancellation never stops another owner's motion. Missing assets fall back to bounded procedural movement. No added motion clip is required for the six-model corpus.

`modelMotion` flags another owner's explicit animation. Do not flag the native base idle or this controller's own bound motion, which would cause it to interrupt itself. `userControl` covers manual avatar actions and tracking channels that require exclusive ownership. Model-specific bindings remain configuration, separate from generic retargetable clips.

## R6 and R7 ports

R6 invokes `playVisualBehavior('amused' | 'surprised' | 'concerned' | 'focused')` only after its existing deterministic reaction policy admits a silent reaction. This package imports no R6 code and changes no reaction policy.

A future R7 maps its own mood, attention, activity, and reaction decisions to `VisualBehaviorPort`. The visual layer accepts requests and intensity/activity settings. It contains no Director, autonomous thoughts, memory reads, salience decisions, or proactive speech. R4 has no dependency here.

## Upstream PR candidate

The isolated renderer change adds one optional expression-phase callback, forwards it through `ThreeScene`, and extends the existing frame callback with current ACT/lip-sync ownership and committed source identity. Existing two-argument callbacks remain assignable. No callback means no expression-phase work beyond the existing conditional. No default renderer behavior changes.

Files: `VRMModel.vue`, `ThreeScene.vue`, `composables/vrm/runtime-hook.ts`, and its barrel export. Keep this generic seam separate from the behavior package when proposing an upstream PR. Upstream renderer tests, strict typechecks, and the real corpus exercise cover this change.

## Local corpus and privacy

Select local files in the dev gallery or pass the read-only directory to the inventory tool. File bytes stay in the browser session. Generated evidence contains capabilities, dimensions, timings, resource counts, and local screenshots. It contains no copied VRM assets. Keep evidence and screenshots outside Git. Revoke object URLs and detach both callbacks during teardown.
