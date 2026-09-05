import * as stylex from "@stylexjs/stylex"

/**
 * The measurements the interface is built out of, derived rather than chosen.
 *
 * Fluid functionalism specifies its default size as a 36px control carrying
 * 13px text, and a compact size as 28px carrying 12px. This interface sets body
 * text at 13.5px, so every control height here is the upstream height scaled by
 * 13.5/13 — 1.0385 — and rounded to the 4px grid:
 *
 *   36 x 1.0385 = 37.38 -> control      36px
 *   28 x 1.0385 = 29.08 -> controlDense 28px
 *
 * At this base the ratio is small enough that both land back on their upstream
 * values, which is a result rather than a coincidence: 13.5px is half a pixel
 * off the size the scale was drawn for, and half a pixel cannot survive a 4px
 * grid. The derivation is kept anyway, because it is what makes the numbers
 * answerable — change the body size and these follow, instead of being re-chosen
 * by eye.
 *
 * Icons are the exception that proves the ratio is about text, not about
 * everything. They stay at 16/14/12 rather than scaling, because a Lucide glyph
 * is drawn on a 24px grid with a 2px stroke and only renders cleanly at even
 * sizes — an odd icon is a blurry icon, and it would be blurry in service of
 * matching a number nobody can see.
 *
 * Values are literals for the same reason the colours are: the StyleX compiler
 * folds these calls at build time and rejects anything it cannot read in the
 * call, so an arithmetic expression or an imported constant fails the build
 * rather than the type check. `sizes.test.ts` reads this file as text and
 * re-derives the numbers, which is what keeps the comment above honest.
 *
 * `defineConsts` rather than `defineVars`, because nothing themes a
 * measurement. A `defineVars` group compiles to custom properties so that a
 * `createTheme` can override them in a subtree; no theme overrides a control
 * height, and paying a `var()` indirection for an override nobody makes is the
 * whole cost with none of the benefit. Consts fold to their literal at every
 * call site instead.
 *
 * That also retires a footgun this module used to carry. While these were
 * variables the module's only remaining import was the folded `var()`, so the
 * bundler dropped the module, so the `:root` block defining those variables was
 * never emitted, so every rule using one was silently discarded by the browser
 * — an unstyled interface with no error anywhere. `main.tsx` carried a
 * side-effect import purely to hold the module in the graph. A const has no
 * `:root` block to lose, so the import is gone and the failure mode with it.
 * `renderer.build.ts` still fails the build on an undefined variable, which now
 * guards `tokens.stylex.ts` alone.
 */
export const size = stylex.defineConsts({
  /** The ordinary control: buttons, fields, selects, rail rows. */
  control: "36px",
  /** Toolbars and chips, where a full-height control would crowd the row. */
  controlDense: "28px",
  /** Badges and counts. Never a hit target — nothing here is clickable. */
  controlMicro: "24px",
  /** The single primary action on an empty state: one control step taller. */
  controlTall: "44px",
  /** The one width every in-row settings control shares, so a column of rows ends on one edge. */
  controlWidth: "200px",

  /**
   * The tab strip, which is also the window's drag region.
   *
   * 44px, which is a 28px tab with 8px of air above and below it — the same
   * step the strip's own zones are separated by, so the air around a tab and
   * the air beside it are one number rather than two. It was 40, at 6px, and
   * that is 6px of drag region on either side of a row of controls: enough for
   * the strip to be a container and not enough for a person to grab reliably.
   */
  tabStrip: "44px",
  /** A rail's own header: shorter than a control row, since it holds no control. */
  railHeader: "32px",

  /**
   * The one inset in the interface.
   *
   * Every region's content edge is this far from the region's own edge: the
   * conversation, the composer, both rails, the tab strip. It exists because
   * the alternative was observed and it looked exactly like what it was — a
   * timeline padded 24, a composer inset 32, a rail header at 14 and its rows
   * at 16, so that no two things in a column agreed where the column started.
   * Nothing here reads a border, so an edge is the only alignment the eye has
   * to go on, and four of them are worse than none.
   *
   * A region that needs more air adds it *inside* this, never by widening it.
   */
  gutter: "16px",

  /**
   * The conversation pane's own inline inset, which is the one place `gutter`
   * is allowed to grow.
   *
   * A rail is a fixed-width strip and 16px is its right edge at every size.
   * The conversation is the column everything else gives its spare room to,
   * and at 16px from the pane edge a narrow pane read as text pressed against
   * glass while a wide one never touched the inset at all, because `column`
   * centres well inside it. So this breathes with the pane: four percent of
   * its width, floored at `gutter` so the narrowest pane loses nothing it
   * needs, capped at 40px so a pane still narrower than `column` plus its two
   * insets does not spend more of itself on air than on the message.
   *
   * Everything that shares the column shares this — the timeline, the
   * composer, the approval tray and the start screen — because an inset any
   * one of them chose alone would put its edge a few pixels off the others'.
   */
  columnInset: "clamp(16px, 4%, 40px)",

  icon: "16px",
  iconDense: "14px",
  iconMicro: "12px",

  /**
   * An attachment preview tile, which is fluid's 80px square through the same
   * ratio as the controls: 80 x 1.0385 = 83.08, to the grid, 84.
   */
  attachmentTile: "84px",

  /**
   * Rail-width anchors. Fixed tokens, because StyleX owns the authored 1440px
   * scale; `preferredRailWidths` lets an untouched rail grow modestly around
   * them while a person's drag remains exact. Most extra room still goes to
   * the conversation, the one column whose lines have nowhere else to grow.
   *
   * The file rail is 248 rather than 232 because every row now spends 14px on
   * a glyph and 12 more on each level of depth: at the old width a file four
   * levels down was an ellipsis with a couple of characters in front of it.
   * The test below is what keeps the two of them from growing until the
   * conversation between them is narrower than a paragraph.
   */
  railFiles: "248px",
  railActivity: "280px",

  /**
   * The conversation column: the one width the messages, the composer and the
   * approval card are all clamped to.
   *
   * They have to share it. Each of those is centred in the same track, so if
   * any one of them chose its own maximum they would stop at different points
   * and the column would read as three columns that happen to overlap — which
   * is what it did before this token existed.
   *
   * 880px rather than the reading measure below, because prose is not the
   * widest thing in the column: a hundred columns of `mono` at this scale is
   * about 750px once its line-number gutter is included, and a code block or a diff that wraps is worse to read than a
   * paragraph that runs slightly long. Prose is held to `measure` inside this.
   */
  column: "880px",

  /**
   * The same column before anything has been said in it.
   *
   * A session with no transcript has nothing to align to, and 880px of empty
   * field is a text box the width of a document with one sentence's worth of
   * work in front of it. 640 is the composer at the width of the prompt people
   * actually type rather than the width of the answers they get back — close
   * to `measure` for the body size, and narrow enough that the field reads as
   * one object in the middle of the pane rather than as a band across it.
   *
   * It applies only while `resting`: the moment a message exists the composer
   * docks and goes back to `column`, because from then on it *does* have
   * something to line up with, and the one-column rule above is about exactly
   * that alignment.
   */
  columnResting: "640px",

  /**
   * The reading measure for prose.
   *
   * In `ch` rather than `px` so it tracks the font actually resolved: the
   * fallback stack spans Segoe UI Variable, Aptos and whatever `system-ui`
   * means on the machine, and a pixel measure would be a different number of
   * characters on each of them.
   */
  measure: "74ch",
  /** The settings panel's measure: a label, its one-line note, and a 200px control, with room between. */
  settingsMeasure: "720px",
})
