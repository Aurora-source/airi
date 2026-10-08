# Findings

- Foundation adapter writes only head and one spine/chest bone.
- Controller caps body rotation at 0.025 radians. All behaviors share one envelope and synchronized timing.
- Catalog has no shoulder, arm, elbow, or wrist channels. This explains the rigid appearance.
- The exact foundation commit is available locally. The new worktree was created from it.
- CodeGraph cannot query the new repository because it is not indexed. No indexing was requested or performed.
- Renderer samples the animation mixer before the visual hook, then updates humanoid, gaze, blink, lip sync, ACT, and springs.
- Existing authored assets include only `idle_loop.vrma`. Retargeted clip playback already exists through owned handles.
- No new licensed, reviewed gesture clips are available locally. Procedural motion remains the implementation for this pass.
- Dependencies installed from the local pnpm cache with the frozen lockfile. No new dependencies were added.
- ccusage daily monitoring ran with offline pricing. It reports all Codex sessions for the day, not this task alone.
- The active model lacks cached pricing. The reported cost is incomplete and cannot represent this task's cost.
- Root typecheck reached 45 successful tasks, then failed because filtered installation left `packages/stage-ui/node_modules` absent.
- The held capture correctly shows head/chest turns and asymmetric posture. Real-time screenshots were delayed beyond short behavior durations.
- Full offline installation hit a Windows rename lock on `bufferutil`. The vivid Vite servers held native dependencies open.
- Stopped only the verified vivid gallery processes on ports 5200 and 5201 before retrying installation.
- Visual review exposed incorrect VRM0 arm directions. Match the installed VRMA retargeter's X/Z quaternion conversion.
## Final implementation review

- Recovery amplitude changes had a second path around controller bounds. Two deterministic red regressions reproduced >11-radian output and NaN. Shared checks now bound both active and recovery values without scaling recovery twice; 52 driver tests pass.
- Independent focused re-review reports no remaining blockers and reproduced bounded recovery values of 0.07864 and 0.
- Root typecheck now passes after the repository's package build materialized missing workspace declarations. Build was 34/34 successful, mostly cached. Generated gallery builds moved outside the repository to avoid concurrent generated-file scanning by root lint.
- Scoped ESLint passes. Renderer regression passes 28 tests. The gallery typecheck was rerun from the renderer workspace because root does not expose vue-tsc.
- Final offline ccusage daily aggregate includes other sessions and cache reads; the active model is unpriced. Persisted `usage-final.json` outside Git. It cannot provide a reliable task cost and does not change the scope.
- Corpus neutral failure was a diagnostic false positive: all reported base/actual quaternion components were identical, with component delta 0. Authored animation norms were slightly below 1 (for example 0.99999996366), causing Quaternion.angleTo to report 0.000539 rad against itself. Neutral now uses exact equality, a stronger restoration check; diagnostic offset angles use normalized copies. Runtime offsets were not changed.
- Full active-bucket primary pose-hook measurements: stretch 0.0892 ms, thinking 0.0883 ms, happy 0.0875 ms, surprise 0.1342 ms. These include gallery owner synchronization; exclude separate expression flush; headless software rendering overlapped the corpus. Native blink/aa/ih/ou/ee/oh remained pure, zero page errors.
- Independent review confirmed the full-bucket measurement and natural-end restoration diagnostics, with no remaining blockers or misleading evidence.
- Root typecheck completed 56/56 tasks. Final production/review builds pass; production bundle has no assignment exposing the diagnostic global (only equality/cleanup references remain).
