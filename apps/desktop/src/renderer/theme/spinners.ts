import * as stylex from "@stylexjs/stylex"
import { colors, radius } from "./tokens.stylex.ts"
import { size } from "./sizes.stylex.ts"

/**
 * One spinner, worn by everything that is waiting on the host.
 *
 * The tab strip's streaming mark, its reconnection mark and the start screen's
 * session mark were three copies of the same ring and three copies of the same
 * keyframes — one animation emitted three times, and a tone or a duration that
 * had to be changed in three files to stay one spinner. `scrollbars.thin` is
 * the precedent: a shared appearance belongs in the theme, not in whichever
 * component needed it first.
 *
 * The ring is `border-box`, so the size token is the diameter a person sees
 * rather than the diameter plus two borders. Reduced motion stops it through
 * the same media query the rest of the interface uses; a stopped ring still
 * reads as "not finished", which is the whole message.
 */
const spin = stylex.keyframes({ to: { transform: "rotate(360deg)" } })

/**
 * The turn itself: one tempo, written once.
 *
 * Both entries below need the same four animation properties, and a ring that
 * turned at a different tempo from the refresh glyph would be two spinners
 * again. Sharing the declaration is what makes "the same turn at the same
 * tempo" a fact rather than a comment.
 */
const turn = {
  animationName: { default: spin, "@media (prefers-reduced-motion: reduce)": "none" },
  animationDuration: "1100ms",
  animationIterationCount: "infinite",
  animationTimingFunction: "linear",
} as const

export const spinners = stylex.create({
  running: {
    flex: "none",
    width: size.iconMicro,
    height: size.iconMicro,
    boxSizing: "border-box",
    borderWidth: "2px",
    borderStyle: "solid",
    borderColor: colors.runningSoft,
    borderTopColor: colors.running,
    borderRadius: radius.pill,
    ...turn,
  },
  /** Inside a strip control, where the row's own height is the constraint. */
  small: { width: "10px", height: "10px" },

  /**
   * The rotation alone, for an element that is already drawn.
   *
   * The file rail's refresh button does not swap its icon for a ring — the
   * arrows *becoming* the spinner is the feedback, the same turn at the same
   * tempo the ring everywhere else keeps. Reduced motion stops it the same
   * way; the disabled button and its `aria-busy` still say the work is on.
   */
  rotate: {
    transformOrigin: "center",
    ...turn,
  },
})
