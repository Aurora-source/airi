# Primary avatar visual review

Local target: `2304491456352929717.vrm`. The avatar file is never committed.

## Capture method

Use the real gallery, native idle animation, normalized adapter, humanoid update, and spring simulation.
Hold controller time at 18%, 42%, and 77% of each behavior. Verify the requested behavior still owns each capture.
Reject the initial real-time screenshot pass. Software capture delays missed short reactions.

## First held pass

- Posture-shift: clear diagonal weight redistribution and asymmetric arm settling. No obvious sleeve or torso collision.
- Glance-left: visible head turn and smaller delayed chest rotation. Returning phases soften the turn.
- Gaze and drift micro behaviors remain deliberately restrained.
- Curious: head tilt, forward torso, shoulder lift, and inward forearms form an inquisitive silhouette.
- Listening: soft forward attention with relaxed asymmetric arms. It stays calmer than curious.
- Stretch and surprise expose inward arm travel. This is unsafe for the primary avatar and requires coordinate correction before acceptance.
- Installed `three-vrm-animation` flips quaternion X/Z components for VRM0. The initial procedural adapter omitted that coordinate conversion.
- Remaining behavior review is in progress.
## Corrected primary pass (held timeline 2)

Confirmation pass 3 repeated all 30 behaviors with the final controller fixes. Another 90 captures retained the requested behavior, all neutral restorations passed, and Chromium reported zero page errors. Sheets 3–4 were re-reviewed first: curious/listening remain coordinated and asymmetric; stretch still opens the arms safely.

All six confirmation sheets were visually re-reviewed. Micro motions remain intentionally low amplitude. Happy/surprise/stretch have clear arm participation; thinking is deliberately asymmetric; concerned/sleepy/relaxed have different collapse, tilt, and settling. No apparent catastrophic clipping or extreme wrists in the sampled primary poses. Small clothing intersections remain a mesh-dependent limit of bounded procedural rotations without collision solving.

- Sheets 1–2 reviewed: native-adjacent micro behaviors stay subtle; glances, posture shift, and up/down have coordinated torso participation without extreme joints.
- Sheets 3–4 reviewed: curious has an asymmetric forward/side stance; attentive is balanced and upright; listening softer and tilted; nod couples neck/chest. Fidget uses a small wrist/posture action. Stretch now opens arms outward and lifts chest after VRM0 conversion. Relaxed drops shoulders; sleepy collapses chest; look-around has distinct scan stages; thoughtful has a deliberate asymmetric arm/torso stance.
- No apparent arm/body crossing or wrist inversion in these corrected primary captures. Loose sleeves obscure elbow detail, so bone bounds and corpus checks complement visual review.
- Sheets 5–6 reviewed: restless alternates weight and wrist adjustments; settle returns lowered arms; thinking makes one forearm/hand distinctly more active; waiting is calm. Happy opens chest and both arms; amused restrains the arms and bounces torso/shoulders; concern collapses forward with a tilt; frown is firmer and downward; surprise recoils quickly with a larger open-arm response; focused stays balanced and quiet.
- Stretch and surprise are corrected from the first held pass, which exposed inward arm motion. Primary anatomy no longer shows crossed hands in the corrected stages. These screenshots establish pose review; runtime sampling and timing checks are also required for motion acceptance.
