import * as stylex from "@stylexjs/stylex"
import { effects, motion } from "./tokens.stylex.ts"

/**
 * The seat a control takes when the keyboard reaches it.
 *
 * This is the borderless rule at its most load-bearing. Every other interface
 * draws a ring around the focused control; this one deepens the shadow under it
 * instead, which means the focus state is two properties — a `boxShadow` that
 * is `none` until `:focus-visible`, and an `outline` suppressed so the platform
 * does not draw the ring anyway — and those two properties were written out
 * nineteen times across sixteen files. Nine of those files had already named
 * the pattern `focusable` and reinvented it locally, which is the clearest
 * possible signal that it wanted to be one thing.
 *
 * `:focus-visible` rather than `:focus`, so a pointer click does not leave a
 * seat behind. `outline: "none"` is safe *only* because `boxShadow` replaces
 * it: dropping the outline without putting something in its place is how a
 * keyboard user loses the caret entirely, and in the high-contrast theme
 * `focusState` becomes an inset baseline rather than a shadow precisely because
 * shadow cannot carry state there.
 *
 * Two namespaces, because two kinds of element need this:
 *
 *   `ring` is the focus state alone, for a control that already describes its
 *   own transitions. Merge it first — `stylex.props(focus.ring, styles.thing)`
 *   — so the control keeps the last word on everything else.
 *
 *   `control` is the ring plus the settling that an interactive element wants
 *   anyway, and it replaces the nine local `focusable` namespaces.
 */
export const focus = stylex.create({
  ring: {
    boxShadow: { default: "none", ":focus-visible": effects.focusState },
    outline: "none",
  },

  /**
   * The transition list is the union of the six lists the local copies had
   * grown, and widening it costs nothing: a browser transitions a property
   * when its value changes and ignores it otherwise, so naming `border-color`
   * on a control that has no border is free.
   *
   * It is not free for an element whose `transform` is written by a dynamic
   * style — `Timeline`'s virtualised rows are positioned that way, and a
   * transition on that transform would animate every row on every scroll. No
   * such element is focusable, which is why the union is safe here; anything
   * that becomes both wants `ring` and its own transition instead.
   */
  control: {
    boxShadow: { default: "none", ":focus-visible": effects.focusState },
    outline: "none",
    transitionProperty: "background-color, border-color, box-shadow, color, opacity, transform",
    transitionDuration: motion.fast,
    transitionTimingFunction: motion.settle,
  },
})
