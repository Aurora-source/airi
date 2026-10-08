# Visual behavior driver

This package adds a small visual behavior layer to AIRI's existing avatar renderers. It contains a 30-entry behavior catalog, four idle intensity settings, an interruptible render-driven controller, and Live2D and VRM adapters.

## Use

```ts
import { createVisualBehaviorController } from '@proj-airi/model-driver-visual'
import { createVrmVisualAdapter } from '@proj-airi/model-driver-visual/vrm'

const adapter = createVrmVisualAdapter(vrm, {
  modelId,
  deferExpressions: true,
})
const visual = createVisualBehaviorController({ adapter })
visual.setIdleIntensity('calm')
visual.start()
visual.playVisualBehavior('amused')
```

The host calls `setExternalActivity` before every update, then calls `update` after base animation sampling. On AIRI's VRM renderer, use `setVrmFrameHook` for this step and `setVrmExpressionFrameHook` to call `adapter.flushExpressions()` after ACT and lip sync. The reused callback context reports the committed model source and ACT/lip-sync ownership. Release the adapter before the host disposes the model. Remove both hooks and call `visual.dispose()` on unmount.

`setVisualActivity` accepts `idle`, `listening`, `thinking`, `waiting`, and `watching`. `cancelBehavior` and `returnToNeutral` fade the current behavior toward neutral. `stop` immediately releases visual ownership and disables scheduling. Speaking, ACT, explicit model motion, and manual control immediately release this layer. The host supplies these facts. This package does not infer them.

For Live2D, use the `./live2d` export. Read the real Cubism parameter table with `discoverLive2DVisualParameters` and supply semantic axis/expression bindings from model configuration. Register the controller with the existing motion plugin pipeline. Retain upstream blink, breath, gaze, physics, and mouth ownership. See [integration instructions](../../docs/visual-presence-integration.md).

## When to use

Use this layer for sparse idle animation, explicit silent reactions, and visual listening or waiting states. R6 and a future R7 can call the renderer-independent `VisualBehaviorPort`. The controller contains no cognition, story interpretation, speech, network calls, or persistence.

## When not to use

Do not use this package as a renderer, an ACT replacement, a lip-sync driver, or a mood decision system. Unsupported capabilities stay neutral or use a smaller compatible pose. Bind custom native expressions and motions explicitly instead of guessing their meanings.

## Local development gallery

```powershell
pnpm -F @proj-airi/model-driver-visual demo
pnpm -F @proj-airi/model-driver-visual inventory 'D:\AI\VRM avatars'
node packages/model-driver-visual/tools/corpus-browser.mjs 'D:\AI\VRM avatars' 'D:\AI\.planning\visual-presence-codex\live-evidence'
```

Open the localhost URL and choose all six local VRM files. The gallery uses upstream `ThreeScene`, keeps one renderer across switches, and provides all behaviors, discovered native expressions, the existing retargeted idle clip, intensity settings, activity controls, interruption controls, cancellation, a three-minute idle demonstration, and a two-pass corpus exercise. No avatar assets enter the repository. The browser harness requires a locally installed Playwright Chromium.

## Validation

```powershell
pnpm -F @proj-airi/model-driver-visual test
pnpm -F @proj-airi/model-driver-visual typecheck
pnpm -F @proj-airi/model-driver-visual demo:typecheck
pnpm -F @proj-airi/model-driver-visual demo:build
```

Deterministic tests use clocks and seeded randomness. Real-model validation and the compatibility matrix are documented in the [foundation report](../../docs/visual-presence-report.md).
