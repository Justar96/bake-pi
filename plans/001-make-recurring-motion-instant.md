# 001 — Make recurring motion instant

- **Status**: DONE
- **Commit**: bdb2f26
- **Severity**: HIGH
- **Category**: Purpose & frequency, performance, accessibility
- **Estimated scope**: 5 files, about 15 lines

## Problem

The busiest paths animate work a person repeats or that streaming repeats for
them. That makes input feel delayed and, in two places, spends layout or paint
on every update.

```tsx
// apps/desktop/src/renderer/features/conversation/Timeline.tsx:261 — current
viewport: { height: "100%", overflowY: "auto", paddingInline: size.gutter, scrollBehavior: { default: "smooth", "@media (prefers-reduced-motion: reduce)": "auto" } },

// apps/desktop/src/renderer/features/conversation/Composer.tsx:625 — current
transitionProperty: "background-color, border-color, box-shadow",

// apps/desktop/src/renderer/features/workbench/ActivityRail.tsx:247 — current
transitionProperty: "width",

// apps/desktop/src/renderer/features/workbench/TabStrip.tsx:268 — current
transitionProperty: "background-color",

// apps/desktop/src/renderer/features/workbench/TabStrip.tsx:294 — current
animationDuration: { default: "1100ms", "@media (prefers-reduced-motion: reduce)": "1ms" },
```

`Timeline` retargets `scrollIntoView` for each streamed delta, so global smooth
scrolling repeatedly chases a moving endpoint. Composer focus is a frequent
keyboard path. The activity meter animates layout width. A 1ms infinite spinner
under reduced motion accelerates motion rather than removing it.

## Target

- Stream following, composer focus, tab selection, and the recurring context
  meter update instantly.
- The spinner remains `1100ms linear` normally and becomes a static ring under
  `prefers-reduced-motion: reduce`.
- App's continuously travelling indeterminate progress bar uses `linear`.
- Do not add replacement motion to rows, tabs, menus, streaming blocks, or
  keyboard navigation.

## Repo conventions to follow

- Motion values live in `apps/desktop/src/renderer/theme/tokens.stylex.ts`.
- Reduced-motion branches are property values inside `stylex.create`, as in
  `App.tsx`'s splash animation.
- Renderer component styles remain StyleX-only and statically analyzable.

## Steps

1. In `Timeline.tsx`, remove `scrollBehavior` from `styles.viewport`.
2. In `Composer.tsx`, remove the transition properties from `styles.composer`;
   keep the focus-within fill, high-contrast ring, and shadow unchanged.
3. In `ActivityRail.tsx`, remove the width transition from `styles.fill`.
4. In `TabStrip.tsx`, remove the selected-tab background transition and make
   `styles.spinner.animationName` conditional: `spin` by default and `"none"`
   for reduced motion. Keep its normal `1100ms` duration and `linear` timing.
5. In `App.tsx`, change only the indeterminate bar's timing to `"linear"`.

## Boundaries

- Do NOT change component behavior, event handling, or markup.
- Do NOT animate virtual rows, streamed blocks, queues, menus, or tabs.
- Do NOT add dependencies.
- If a step does not match the code stamped above, stop and report drift.

## Verification

- **Mechanical**: `bun run typecheck:renderer`, `bun test`, `bun run build` all
  exit zero.
- **Feel check**: stream a long answer and confirm the timeline follows without
  easing behind each token; traverse composer controls by keyboard and confirm
  focus lands immediately; enable reduced motion and confirm the host spinner
  is a static ring.
- **Done when**: no high-frequency path above carries motion and reduced motion
  cannot produce a 1ms infinite loop.
