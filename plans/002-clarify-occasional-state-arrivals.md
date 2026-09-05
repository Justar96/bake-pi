# 002 — Clarify occasional state arrivals

- **Status**: DONE
- **Commit**: bdb2f26
- **Severity**: MEDIUM
- **Category**: State indication, spatial consistency, accessibility
- **Estimated scope**: 4 files, about 45 lines

## Problem

Blocking approvals and rare recovery notices currently appear without spatial
context, while drawers and modals already enter but use a generic curve and lose
all feedback under reduced motion.

```tsx
// apps/desktop/src/renderer/features/conversation/ApprovalTray.tsx:80 — current
card: { /* raised card, no entrance */ },

// apps/desktop/src/renderer/features/conversation/Timeline.tsx:316 — current
banner: { /* overlay banner, no entrance */ },

// apps/desktop/src/renderer/features/workbench/Overlay.tsx:229-230 — current
const enterDrawer = stylex.keyframes({ from: { transform: "translateX(100%)" } })
const enterModal = stylex.keyframes({ from: { opacity: 0, transform: "translateY(4px) scale(0.99)" } })
```

Approvals come from the composer and recovery banners come from above the log;
a single mount entrance communicates those relationships. Drawers and modals
are occasional enough to animate, but a professional coding tool should not use
overshoot and reduced motion should retain a short opacity cue.

## Target

```tsx
// exact curves and timing tokens
settle: "cubic-bezier(0.23, 1, 0.32, 1)",
move: "cubic-bezier(0.77, 0, 0.175, 1)",
drawer: "cubic-bezier(0.32, 0.72, 0, 1)",
accessibleFade: "200ms",
```

- Approval: `opacity: 0` plus `translateY(100%)` to rest, `160ms` strong
  ease-out; reduced motion uses opacity only for `200ms`.
- Banner: `opacity: 0` plus `translateY(-100%)` to rest, `160ms` strong
  ease-out; reduced motion uses opacity only for `200ms`.
- Drawer: `translateX(100%)` to rest with the exact drawer curve, `160ms`.
- Modal: `opacity: 0` plus `scale(0.96)` to rest, `160ms` strong ease-out,
  centered origin; no overshoot.
- Scrim: opacity only, `160ms` strong ease-out.
- Closing remains immediate because it is the system response and the current
  component lifecycle unmounts the layer; do not add delayed teardown state.

## Repo conventions to follow

- Extend the existing `motion` variable group in
  `apps/desktop/src/renderer/theme/tokens.stylex.ts`; do not create local
  cubic-beziers.
- Use `stylex.keyframes` for these predetermined mount-only entrances.
- Use conditional `animationName` and `animationDuration` property values for
  reduced motion; the reduced keyframe contains opacity only.

## Steps

1. Update `motion.settle` to the exact strong ease-out above; add `move`,
   `drawer`, and `accessibleFade` to the same token group. Update its rationale.
2. In `ApprovalTray.tsx`, add the approval and opacity-only keyframes and apply
   them to each approval card. Use `motion.moderate` normally and
   `motion.accessibleFade` under reduced motion.
3. In `Timeline.tsx`, add equivalent banner keyframes and apply them to the
   banner itself so changes to an already-mounted retry do not remount it.
4. In `Overlay.tsx`, keep the existing mount architecture. Use the drawer curve
   for the drawer; change the modal start to `scale(0.96)` plus opacity, remove
   overshoot, and select opacity-only keyframes plus `accessibleFade` for
   reduced motion.
5. Preserve all focus traps, ARIA, auto-focus, and Escape behavior.

## Boundaries

- Do NOT animate composer menus, timeline rows, streamed output, tabs, file
  rows, code, diffs, or Markdown.
- Do NOT add exit-state React logic, motion libraries, or dependencies.
- Animate transform and opacity only.
- If a step does not match the code stamped above, stop and report drift.

## Verification

- **Mechanical**: `bun run typecheck:renderer`, focused renderer tests,
  `bun run build`, `bun run smoke`, and `bun run journey` all exit zero.
- **Feel check**: trigger an approval, recovery banner, drawer, and modal. At
  10% DevTools playback confirm each begins from its semantic direction and the
  modal stays centered. Toggle reduced motion and confirm position/scale motion
  disappears while a 200ms opacity cue remains.
- **Done when**: occasional state arrivals have one coherent motion language,
  no deliberate UI entrance exceeds 200ms, and frequent work remains instant.
