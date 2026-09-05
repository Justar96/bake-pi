import * as stylex from "@stylexjs/stylex"

/**
 * Text for a screen reader and for nothing else.
 *
 * There were two of these — `Composer.srOnly` and `SettingsRail.visuallyHidden`
 * — and they had already drifted apart. The settings copy had lost the padding,
 * margin and border resets, which matters more than it sounds: a `1px` box that
 * still carries a control's inherited padding is not a `1px` box, and it can
 * push the layout it is hiding inside by a few pixels that nobody can account
 * for. This is the complete version, which is the composer's.
 *
 * `clip` is deprecated and `clipPath: "inset(50%)"` is its replacement, but the
 * pair is kept: `clip` is what older assistive technology reads, and the two
 * together are the recipe that has survived every round of this argument.
 * Nothing here uses `display: none` or `visibility: hidden`, because both
 * remove the element from the accessibility tree, which is the one thing this
 * must not do.
 */
export const a11y = stylex.create({
  visuallyHidden: {
    position: "absolute",
    width: "1px",
    height: "1px",
    overflow: "hidden",
    padding: 0,
    margin: "-1px",
    borderWidth: 0,
    clip: "rect(0, 0, 0, 0)",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  },
})
