import * as stylex from "@stylexjs/stylex"
import { colors, effects, motion, radius, space, typography } from "../theme/tokens.stylex.ts"

/**
 * The hover hint for a control whose name no longer fits on it.
 *
 * An icon-only button carries its name in `aria-label`, which is everything a
 * screen reader needs and nothing a sighted person pointing at it gets to
 * see. The bubble repeats that name on hover and on keyboard focus — the two
 * intents a tooltip answers — and is `aria-hidden` because announcing it
 * would say the button's name twice.
 *
 * CSS all the way down, and that is a decision rather than a shortcut. The
 * default marker on the wrapper and `when.ancestor` on the bubble are the
 * whole mechanism: no state, no timer, no portal, and nothing for the CSP to
 * object to. `visibility` is transitioned alongside `opacity` so the hidden
 * bubble is also gone from hit-testing, and a disabled trigger still shows
 * its hint because `:hover` matches one even though its click is suppressed.
 * The default marker rather than a defined one because a bubble answers its
 * own wrapper and nothing else — two tooltips side by side never see each
 * other's hover, which is all a named marker would add.
 *
 * The show delay is a literal, not a motion token: the tokens govern how
 * long a thing takes to move once it has decided to, and this is the
 * decision itself — 350ms of dwelling on a control before the interface
 * answers a question the person may not have been asking.
 */
export const Tooltip = ({ label, align = "center", children }: {
  label: string
  /** `end` for the last control in a row, so the bubble ends at the control's edge instead of jutting past the rail. */
  align?: "center" | "end"
  children: React.ReactNode
}): React.JSX.Element => (
  <span {...stylex.props(stylex.defaultMarker(), styles.wrap)}>
    {children}
    <span aria-hidden="true" {...stylex.props(styles.bubble, align === "end" && styles.bubbleEnd)}>{label}</span>
  </span>
)

const styles = stylex.create({
  wrap: { position: "relative", display: "inline-flex", flex: "none" },
  bubble: {
    position: "absolute",
    insetBlockStart: "calc(100% + 6px)",
    insetInlineStart: "50%",
    /**
     * Scales out of the trigger rather than fading in place: a bubble should
     * read as having come out of the control it names, so the origin sits on
     * the edge that faces it and the entrance is 0.97 — close enough to full
     * size that the motion is felt rather than watched.
     */
    transform: {
      default: "translateX(-50%) scale(0.97)",
      [stylex.when.ancestor(":hover")]: "translateX(-50%) scale(1)",
      [stylex.when.ancestor(":focus-within")]: "translateX(-50%) scale(1)",
    },
    transformOrigin: "top center",
    zIndex: 50,
    paddingBlock: space.xs,
    paddingInline: space.sm,
    color: colors.text,
    /**
     * `surfaceOverlay` under `liftOverlay`, because that is what the palette
     * sets the pair aside for — "menus, popovers, dialogs, always above their
     * substrate". A tooltip is the smallest of those, and in the light theme
     * the shadow is the only thing telling it from the white page beneath it.
     */
    backgroundColor: colors.surfaceOverlay,
    borderWidth: effects.hairline,
    borderStyle: "solid",
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    boxShadow: effects.liftOverlay,
    fontFamily: typography.ui,
    fontSize: typography.caption,
    lineHeight: typography.captionLine,
    whiteSpace: "nowrap",
    pointerEvents: "none",
    opacity: {
      default: 0,
      [stylex.when.ancestor(":hover")]: 1,
      [stylex.when.ancestor(":focus-within")]: 1,
    },
    visibility: {
      default: "hidden",
      [stylex.when.ancestor(":hover")]: "visible",
      [stylex.when.ancestor(":focus-within")]: "visible",
    },
    transitionProperty: "opacity, visibility, transform",
    /** The exit is the fast one, as everywhere: a hint leaving wants to be gone. */
    transitionDuration: {
      default: motion.fastExit,
      [stylex.when.ancestor(":hover")]: motion.moderate,
      [stylex.when.ancestor(":focus-within")]: motion.moderate,
    },
    transitionDelay: {
      default: "0ms",
      [stylex.when.ancestor(":hover")]: "350ms",
      [stylex.when.ancestor(":focus-within")]: "350ms",
    },
    transitionTimingFunction: motion.settle,
  },
  bubbleEnd: {
    insetInlineStart: null,
    insetInlineEnd: 0,
    transformOrigin: "top right",
    transform: {
      default: "scale(0.97)",
      [stylex.when.ancestor(":hover")]: "scale(1)",
      [stylex.when.ancestor(":focus-within")]: "scale(1)",
    },
  },
})
