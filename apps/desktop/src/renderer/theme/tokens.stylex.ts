import * as stylex from "@stylexjs/stylex"

/**
 * A grey interface, where only state and diffs carry a hue.
 *
 * Every surface, every piece of text, the accent, the focus state and the
 * selection are neutral grey — equal in all three channels, no cast in either
 * direction. That is the whole look, and it is also the reason the elevation
 * ladder below is the only thing separating one region from another: with hue
 * gone from the chrome, a boundary can only be a difference in lightness, so
 * the steps have to be steps somebody measured rather than shades somebody liked.
 *
 * The accent is grey too. On a grey ground the brightest step *is* the accent —
 * a near-white button on a near-black canvas is as emphatic as a blue one, and
 * it does not introduce a hue the rest of the interface then has to answer for.
 *
 * State is the exception. `reasoning`, `success`, `running`, `warning` and
 * `danger` are five hues — violet, green, blue, amber, red — because on a grey
 * ground a hue is the fastest way to tell a failure from a thought, and those
 * are the moments the interface most needs to be read at a glance. Hue is still
 * not allowed to be the only thing announcing a state: every place that uses
 * one says the same thing a second way — a glyph, a word, or a shape — so the
 * meaning survives for anyone who does not see the colour.
 *
 * The diff tints are hued too, green for added and red for removed, under a
 * `+` and a `-` that carry the claim on their own.
 *
 * Two rules govern the whole palette, both from the fluid functionalism system
 * this interface follows:
 *
 *   Elevation, not outline. A raised element is a lighter background and a
 *   shadow, never a line drawn around it. `hairline` is the escape hatch, and
 *   it is zero everywhere except the high-contrast theme, where an outline is
 *   the accessibility requirement rather than a decoration.
 *
 *   Light and dark lift differently. In dark, each step adds light. In light,
 *   surfaces flatten to white by the second step and shadow alone carries the
 *   remaining depth, because a white surface cannot get whiter.
 *
 * Every colour below is written as a literal, and it has to be: the StyleX
 * compiler folds these calls at build time and refuses anything it cannot see,
 * so a palette imported from a neighbouring module fails the build rather than
 * the type check. That is also why `contrast.test.ts` reads this file as text
 * instead of importing it — a `.stylex.ts` module throws the moment it is
 * loaded without the Babel plugin, and the ratios worth asserting are the ones
 * in the file the compiler actually reads.
 */
export const colors = stylex.defineVars({
  /** The deepest ground. Nothing sits behind it. */
  canvas: "#111111",
  /** A recess in the canvas: rails, gutters, hunk headers. */
  canvasSubtle: "#151515",
  /** The first lift. Cards, headers, the ordinary raised thing. */
  surface: "#1b1b1b",
  /** The second lift. Composer, inputs, anything a person acts on. */
  surfaceRaised: "#222222",
  /** The third lift. Menus, popovers, dialogs — always above their substrate. */
  surfaceOverlay: "#2b2b2b",
  /** Below the canvas: code and tool output, which should read as inset. */
  sunken: "#0c0c0c",

  text: "#eeeeee",
  textMuted: "#aaaaaa",
  textFaint: "#797979",

  /**
   * Brand, expressed as lightness rather than as hue.
   *
   * It is the top of the grey ladder — brighter than any surface can get — so
   * a link, a send button and a focus state read as *placed* on the page rather
   * than as another step of it. `accentOn` is the canvas itself, which is what
   * makes a filled button legible without introducing a second colour.
   */
  accent: "#e8e8e8",
  accentHover: "#ffffff",
  accentSoft: "#252525",
  /** Text drawn *on* the accent, which is the pairing contrast is measured over. */
  accentOn: "#111111",

  /**
   * The five states, each with its own hue.
   *
   * Every status colour is asserted at 4.5 against the canvas and against its
   * own soft fill in `contrast.test.ts`, so a badge stays readable both on the
   * page and inside its chip. The softs are the same hue pulled down to sit one
   * step off the canvas, so a badge and its fill move together.
   */
  reasoning: "#b39ddb",
  reasoningSoft: "#1d1a26",
  success: "#5fcf80",
  successSoft: "#13221a",
  running: "#63a4f0",
  runningSoft: "#131c2a",
  warning: "#e0b04a",
  warningSoft: "#26200f",
  /**
   * Brightened from `#f0625d`, which cleared 4.5 on the canvas and reached only
   * 4.46 on `surfaceOverlay` — and a failure is read most often in a modal,
   * which is that surface. It was the one status colour that did not survive
   * the two steps up from the canvas; `contrast.test.ts` now measures all five
   * there so the next one cannot.
   */
  danger: "#f4706b",
  dangerSoft: "#2a1514",

  /**
   * Diff tinting, separate from status.
   *
   * An added line is not a success and a removed line is not a danger, so the
   * two pairs stay separate tokens even where the hues coincide — sharing a
   * value would mean tuning a diff row moved a failed tool card with it.
   *
   * Green for added and red for removed, and still the `+` and `-` markers in
   * `Diff.tsx` are real characters in the row rather than decoration: they are
   * what a reader actually parses, and what survives being copied out as a
   * patch.
   */
  diffAdded: "#6fcf8a",
  diffAddedSoft: "#14231a",
  diffRemoved: "#ef7d78",
  diffRemovedSoft: "#261414",

  selection: "#383838",
  selectionText: "#ffffff",

  /**
   * Drawn only where `hairline` gives it a width, which is the high-contrast
   * theme and nowhere else.
   */
  border: "#2a2a2a",
  borderStrong: "#474747",
  focus: "#dddddd",
})

/** Dark is what `defineVars` already declared, so this theme overrides nothing. */
export const darkTheme = stylex.createTheme(colors, {})

/**
 * Light flattens to white early, so the ladder from `surface` up is carried by
 * shadow rather than by tint. `canvasSubtle` still recesses, because a rail
 * that reads as *behind* the page is the one thing tint does better than shadow.
 *
 * The accent inverts rather than lightens: near-black on white, where dark had
 * near-white on black. Both are the same decision — the accent is whichever end
 * of the grey ladder the substrate is not.
 */
export const lightTheme = stylex.createTheme(colors, {
  canvas: "#f5f5f5",
  canvasSubtle: "#eaeaea",
  surface: "#fdfdfd",
  surfaceRaised: "#ffffff",
  surfaceOverlay: "#ffffff",
  sunken: "#ededed",

  text: "#171717",
  textMuted: "#545454",
  textFaint: "#6f6f6f",

  accent: "#333333",
  accentHover: "#141414",
  accentSoft: "#e2e2e2",
  accentOn: "#ffffff",

  reasoning: "#6a4fb3",
  reasoningSoft: "#ece7f7",
  success: "#1e7a3c",
  successSoft: "#e1f3e6",
  running: "#1f5fb8",
  runningSoft: "#e1ebf9",
  warning: "#8a5a00",
  warningSoft: "#f7ecd2",
  danger: "#b3261e",
  dangerSoft: "#f9e0de",

  diffAdded: "#1e7a3c",
  diffAddedSoft: "#dff5e4",
  diffRemoved: "#b3261e",
  diffRemovedSoft: "#fbe3e1",

  selection: "#d0d0d0",
  selectionText: "#101010",

  border: "#d6d6d6",
  borderStrong: "#a8a8a8",
  focus: "#2b2b2b",
})

/**
 * The one theme that is allowed to draw lines.
 *
 * Everything else here relies on a lift a person can see, and someone who needs
 * this theme may not be able to. `hairline` becomes a real pixel and every
 * surface gets an outline, so the shape of a control survives when its tint
 * does not.
 */
export const highContrastTheme = stylex.createTheme(colors, {
  canvas: "#000000",
  canvasSubtle: "#000000",
  surface: "#0a0a0a",
  surfaceRaised: "#131313",
  surfaceOverlay: "#1c1c1c",
  sunken: "#000000",

  text: "#ffffff",
  textMuted: "#eeeeee",
  textFaint: "#cccccc",

  accent: "#e0e0e0",
  accentHover: "#ffffff",
  accentSoft: "#2a2a2a",
  accentOn: "#000000",

  reasoning: "#c9b8ff",
  reasoningSoft: "#1a1426",
  success: "#6ee89a",
  successSoft: "#0d2415",
  running: "#7fc0ff",
  runningSoft: "#0c1a2c",
  warning: "#ffcc4d",
  warningSoft: "#2a2008",
  danger: "#ff7b73",
  dangerSoft: "#2c0f0d",

  diffAdded: "#7ff0a0",
  diffAddedSoft: "#0f2a18",
  diffRemoved: "#ff9a94",
  diffRemovedSoft: "#2c1010",

  selection: "#4a4a4a",
  selectionText: "#ffffff",

  border: "#bdbdbd",
  borderStrong: "#ffffff",
  focus: "#ffffff",
})

/**
 * The spacing ramp.
 *
 * `defineConsts`, like `radius`, `typography` and `size`, because no theme
 * overrides a gap. The three groups that stay `defineVars` — `colors`,
 * `effects` and `motion` — are exactly the three a `createTheme` or a media
 * query rewrites at runtime, which is the whole rule for choosing between the
 * two: a variable buys an override, and a scale nobody overrides should be the
 * literal it already is.
 */
export const space = stylex.defineConsts({
  xs: "4px", sm: "8px", md: "12px", lg: "16px", xl: "24px", xxl: "32px", xxxl: "48px",
})

/**
 * Restrained geometry for controls and contained surfaces.
 *
 * Rails and layout planes remain square. The desktop frame's small corner is
 * native window chrome rather than a second clipped renderer surface; inside
 * it a control may soften by one pixel, a contained object by two and a card
 * by four. `pill` is reserved for geometry that is truly circular — a status
 * dot or spinner — rather than decorative labels.
 */
export const radius = stylex.defineConsts({ sm: "1px", md: "2px", lg: "4px", pill: "999px" })

/**
 * A seven-step ramp anchored on 13.5px body text, with its leading attached.
 *
 * The sizes are named for what they are rather than how big they are, because
 * `sizeSm` tells a reader nothing about whether it belongs on a caption or a
 * button label, and two people will disagree. `caption`, `label` and `body`
 * cannot be disagreed about.
 *
 * Every size carries its own line height as a paired token in pixels, not as
 * one shared ratio. A ratio is the right default when a scale is unknown; here
 * it is known, and it was producing 12 x 1.58 = 18.96px leading on captions and
 * 28 x 1.3 = 36.4px on headings — neither on a grid, both a fraction off what
 * the next element assumed. The pairs below are all multiples of four, so a
 * column of mixed text still lands on the same rhythm as the controls beside it.
 *
 * The half pixels are not a mistake. 13.5px is the base this interface reads
 * best at next to an editor, and the ramp is stepped from it rather than
 * rounded to whole pixels afterwards — rounding would have collapsed `label`
 * and `body` into one size, and they are doing different jobs.
 *
 * Downward the step is 1px, until `micro`, which stops at 11. That is the
 * floor: below it a tracked uppercase eyebrow stops being scannable and starts
 * being decoration, so the ramp holds there rather than continuing the step for
 * the sake of the pattern. Upward the step is 2px, then whole numbers, until the
 * deliberate display jump: onboarding needs enough editorial contrast to carry
 * a sparse screen while the working interface stays on the compact ramp.
 *
 * Every leading is on the 4px grid, so a
 * column of mixed sizes still lands on the same rhythm as the controls beside
 * it. The resulting ratios run from 1.13 to 1.48, tightest at the display
 * sizes, which is the right direction — a headline set at a paragraph's leading
 * reads as a paragraph that happens to be large.
 */
export const typography = stylex.defineConsts({
  ui: '"Geist Sans", "Segoe UI Variable Text", "Aptos", "Segoe UI", system-ui, sans-serif',
  /**
   * Display type keeps the same Geist Sans voice as the working interface.
   *
   * `display` still names an editorial role: its larger scale, open measure and
   * regular weight establish hierarchy without introducing a decorative second
   * family. Keeping one sans family makes compact controls and sparse states
   * feel like the same product.
   */
  display: '"Geist Sans", "Segoe UI Variable Text", "Aptos", "Segoe UI", system-ui, sans-serif',
  mono: '"Geist Mono", "Cascadia Code", "SF Mono", Menlo, Consolas, monospace',

  /** Eyebrows, counts, line numbers. Uppercase and tracked, never a paragraph. */
  micro: "11px", microLine: "16px",
  /** Metadata under a title: timestamps, token counts, file paths. */
  caption: "11.5px", captionLine: "16px",
  /** Control labels and chips — text inside something, rather than text about it. */
  label: "12.5px", labelLine: "16px",
  /** The default. Conversation, prose, anything a person reads rather than scans. */
  body: "13.5px", bodyLine: "20px",
  /** A section or card heading. */
  subtitle: "15.5px", subtitleLine: "20px",
  /** A view heading. */
  title: "19px", titleLine: "24px",
  /** Empty states and onboarding, where one line of type carries the whole screen. */
  hero: "32px", heroLine: "36px",
})

/**
 * The shadows that do the work outlines used to, and the hairline that does not.
 *
 * Themed alongside the colours because the two lift strategies need different
 * shadows: dark does most of the work with solid tint and keeps only a compact
 * seat beneath a raised object, while light keeps the surface white and asks
 * shadow to carry the whole step. One recipe cannot be right for both.
 */
export const effects = stylex.defineVars({
  /** Border width. Zero everywhere but high contrast — the borderless rule, expressed once. */
  hairline: "0px",
  /** Dark surfaces separate mostly by solid tint; this is only their compact seat. */
  lift: "0 1px 2px rgba(0, 0, 0, 0.18)",
  /** The active surface gets one restrained step, without reading as a floating tile. */
  liftRaised: "0 2px 5px rgba(0, 0, 0, 0.24)",
  /** Keyboard focus is a firmer seat, never a ring drawn around the control. */
  focusState: "0 3px 8px rgba(0, 0, 0, 0.42)",
  /** The third: menus and dialogs, which must read as above everything. */
  liftOverlay: "0 10px 28px rgba(0, 0, 0, 0.52)",
  /** The scrim behind a modal. */
  scrim: "rgba(0, 0, 0, 0.66)",

  /**
   * The scrollbar thumb, at rest, under the pointer, and while dragged.
   *
   * A fixed overlay ramp — 8, 12, 16 percent — rather than three palette
   * colours, because a scrollbar sits on whatever it is scrolling and has to
   * be the same weight over a code block as over a rail. Tinting instead of
   * colouring is what makes that true without a token per substrate.
   *
   * `scrollbars.ts` is the only consumer, and the reason these live here
   * rather than there is that they change per theme, which only a theme
   * override can do.
   */
  scrollThumb: "rgba(255, 255, 255, 0.08)",
  scrollThumbHover: "rgba(255, 255, 255, 0.12)",
  scrollThumbActive: "rgba(255, 255, 255, 0.16)",
})

export const lightEffects = stylex.createTheme(effects, {
  hairline: "0px",
  lift: "0 1px 2px rgba(0, 0, 0, 0.07)",
  liftRaised: "0 2px 8px rgba(0, 0, 0, 0.09)",
  focusState: "0 3px 10px rgba(0, 0, 0, 0.18)",
  liftOverlay: "0 16px 40px rgba(0, 0, 0, 0.16)",
  scrim: "rgba(0, 0, 0, 0.38)",

  // The same ramp, inverted: the overlay is ink on a light ground rather than
  // light on a dark one.
  scrollThumb: "rgba(0, 0, 0, 0.08)",
  scrollThumbHover: "rgba(0, 0, 0, 0.12)",
  scrollThumbActive: "rgba(0, 0, 0, 0.16)",
})

export const darkEffects = stylex.createTheme(effects, {})

export const highContrastEffects = stylex.createTheme(effects, {
  hairline: "1px",
  lift: "none",
  liftRaised: "none",
  // Shadow cannot carry state here, so a short inner baseline does.
  focusState: "inset 0 -2px 0 #ffffff",
  liftOverlay: "none",
  scrim: "rgba(0, 0, 0, 0.86)",

  // High contrast opts out of the subtle ramp deliberately. A thumb somebody
  // cannot see is a thumb somebody cannot grab, and this is the theme chosen
  // by people for whom eight percent is not there at all.
  scrollThumb: "rgba(255, 255, 255, 0.45)",
  scrollThumbHover: "rgba(255, 255, 255, 0.7)",
  scrollThumbActive: "rgba(255, 255, 255, 0.9)",
})

/**
 * Durations and easings, taken from the fluid functionalism motion scale.
 *
 * Three speeds, and an exit that is always quicker than its entrance: a thing
 * arriving wants to be noticed, a thing leaving wants to be gone. The springs
 * upstream are physical; these are their CSS settlement — `settle` for a
 * surface coming to rest and `move` for a deliberate state change. Neither
 * curve bounces: motion here explains state and position rather than lending
 * the interface a character performance.
 *
 * Reduced motion is handled *here* rather than in each component. Movement
 * collapses through the duration tokens under the OS setting, so a transition
 * written anywhere in the interface obeys it without its author remembering to
 * ask. `accessibleFade` is the one exception: it is explicitly opacity-only,
 * so that gentle fade survives without making anything travel.
 */
export const motion = stylex.defineVars({
  fast: { default: "80ms", "@media (prefers-reduced-motion: reduce)": "1ms" },
  fastExit: { default: "60ms", "@media (prefers-reduced-motion: reduce)": "1ms" },
  moderate: { default: "160ms", "@media (prefers-reduced-motion: reduce)": "1ms" },
  moderateExit: { default: "120ms", "@media (prefers-reduced-motion: reduce)": "1ms" },
  slow: { default: "240ms", "@media (prefers-reduced-motion: reduce)": "1ms" },
  slowExit: { default: "160ms", "@media (prefers-reduced-motion: reduce)": "1ms" },
  accessibleFade: { default: "200ms", "@media (prefers-reduced-motion: reduce)": "200ms" },
  settle: "cubic-bezier(0.23, 1, 0.32, 1)",
  move: "cubic-bezier(0.77, 0, 0.175, 1)",
})
