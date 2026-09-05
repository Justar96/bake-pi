import { describe, expect, test } from "bun:test"

/**
 * The size scale as arithmetic rather than as taste.
 *
 * `sizes.stylex.ts` claims its control heights are the fluid functionalism
 * defaults scaled to this interface's body size and rounded to a 4px grid. That
 * claim is worth exactly as much as a check on it: a later edit that nudges one
 * height to make a particular row look right would leave the comment saying
 * something the file no longer does, and nothing would notice.
 *
 * Read as text for the same reason `contrast.test.ts` is — a `.stylex.ts`
 * module calls into the compiler's own API, which throws the moment it runs
 * without the Babel plugin, and `bun test` has no plugin. The numbers asserted
 * here are therefore the same bytes the compiler turns into CSS.
 */
const source = await Bun.file(new URL("./sizes.stylex.ts", import.meta.url)).text()
const tokens = new Map(
  [...source.matchAll(/^\s{2}([a-zA-Z]+): "([^"]+)",/gm)].map((match) => [match[1]!, match[2]!]),
)

const px = (name: string): number => {
  const raw = tokens.get(name)
  expect(raw, `${name} is declared`).toBeDefined()
  expect(raw, `${name} is a pixel value`).toMatch(/^\d+px$/)
  return Number.parseInt(raw!, 10)
}

/** Fluid's own defaults, and the body size this interface sets. */
const FLUID_CONTROL = 36
const FLUID_COMPACT = 28
const FLUID_TEXT = 13
const OUR_TEXT = 13.5

describe("control heights", () => {
  const ratio = OUR_TEXT / FLUID_TEXT

  test("are the upstream heights scaled by the text ratio, rounded to the 4px grid", () => {
    expect(px("control")).toBe(Math.round((FLUID_CONTROL * ratio) / 4) * 4)
    expect(px("controlDense")).toBe(Math.round((FLUID_COMPACT * ratio) / 4) * 4)
  })

  /**
   * The rounding is the whole reason these are literals, so it is worth
   * asserting that it is rounding and not invention: neither derived height
   * may drift further than half a grid step from the value it came from.
   */
  test("stay within half a grid step of the value they were derived from", () => {
    expect(Math.abs(px("control") - FLUID_CONTROL * ratio)).toBeLessThanOrEqual(2)
    expect(Math.abs(px("controlDense") - FLUID_COMPACT * ratio)).toBeLessThanOrEqual(2)
  })

  test("form one ordered ladder", () => {
    expect(px("controlMicro")).toBeLessThan(px("controlDense"))
    expect(px("controlDense")).toBeLessThan(px("control"))
    expect(px("control")).toBeLessThan(px("controlTall"))
  })

  test("all sit on the 4px grid", () => {
    for (const name of ["control", "controlDense", "controlMicro", "controlTall", "tabStrip", "railHeader", "gutter"]) {
      expect(px(name) % 4, `${name} is on the grid`).toBe(0)
    }
  })

  /**
   * Anything a person has to hit needs 24px of it, and `controlMicro` is
   * exactly 24 — which is why the token's comment says it is never a hit
   * target. If it were ever lowered to make a badge sit better, this is where
   * that shows up.
   */
  test("never fall below the minimum target size", () => {
    for (const name of ["control", "controlDense", "controlMicro", "controlTall"]) {
      expect(px(name), `${name} clears WCAG 2.2 target size`).toBeGreaterThanOrEqual(24)
    }
  })
})

describe("icons", () => {
  /**
   * Lucide draws on a 24px grid with a 2px stroke. Odd sizes put that stroke on
   * a half pixel, which is the difference between a crisp glyph and a smudged
   * one at the sizes this interface uses them at.
   */
  test("are even, so the stroke lands on whole pixels", () => {
    for (const name of ["icon", "iconDense", "iconMicro"]) {
      expect(px(name) % 2, `${name} is even`).toBe(0)
    }
  })

  test("are not scaled by the text ratio", () => {
    expect(px("icon")).toBe(16)
  })

  /**
   * The rule is that a control gives an icon at least as much air as the glyph
   * is wide — 2 x icon <= control, so the padding either side sums to no less
   * than the icon itself. The dense pair sits exactly on that line (14 in 28),
   * which is the tightest the scale is allowed to get; anything past it and the
   * glyph starts reading as the control rather than as something inside it.
   */
  test("leave at least as much air around them as the glyph is wide", () => {
    expect(px("icon") * 2).toBeLessThanOrEqual(px("control"))
    expect(px("iconDense") * 2).toBeLessThanOrEqual(px("controlDense"))
  })
})

test("the attachment tile is the upstream 80px square through the same ratio", () => {
  expect(px("attachmentTile")).toBe(Math.round((80 * (OUR_TEXT / FLUID_TEXT)) / 4) * 4)
})

describe("rails", () => {
  /**
   * Activity has already folded at 1024px, but the authored anchors should not
   * need that escape hatch to leave a paragraph-sized centre. This catches a
   * rail-token increase before the responsive layout has to compensate for it.
   */
  test("leave a usable conversation column at the narrowest supported width", () => {
    expect(1024 - px("railFiles") - px("railActivity")).toBeGreaterThanOrEqual(480)
  })

  test("are on the 4px grid", () => {
    expect(px("railFiles") % 4).toBe(0)
    expect(px("railActivity") % 4).toBe(0)
  })
})

test("the reading measure is expressed in characters, not pixels", () => {
  expect(tokens.get("measure")).toMatch(/^\d+ch$/)
})

/**
 * The conversation column and the rails have to coexist at the width the
 * layout claims to hold all three at. If `column` ever grew past what is left
 * over, the middle track would clamp it and the composer, the messages and the
 * approval card would each stop at a different width — which is the drift the
 * token was introduced to end.
 */
test("the conversation column fits between both rails, gutters included", () => {
  // 1440 is the commonest laptop width and the one the three-column layout is
  // tuned for. A column wider than what is left after the rails and its own two
  // gutters is a column the viewport clamps — and a clamped column stops at a
  // different place than the composer beneath it, which is the drift this token
  // exists to end.
  expect(px("column")).toBeLessThanOrEqual(1440 - px("railFiles") - px("railActivity") - 2 * px("gutter"))
})

/**
 * The resting width is a narrowing of that column, not a second one. At or
 * above `column` an empty session's composer would be the wider of the two
 * states and the dock would be a *growth* into a narrower box — which is the
 * opposite of what a first prompt does.
 */
test("the resting column is narrower than the column it returns to", () => {
  expect(px("columnResting")).toBeLessThan(px("column"))
  expect(px("columnResting") % 4).toBe(0)
})

/**
 * The roster, named here so the scale cannot grow by accident.
 *
 * Every measurement in this file is defended by a comment that says where the
 * number came from. A token added without passing through this list is a
 * number nobody argued for, which is the failure this whole module exists to
 * prevent — so adding one is meant to cost a line here.
 */
const TOKENS = [
  "control", "controlDense", "controlMicro", "controlTall",
  // The one width every in-row settings control shares: the settings modal's
  // 720px measure minus its label column, which is where a 200px select stopped
  // being the longest option's width and became the column's.
  "controlWidth",
  "tabStrip", "railHeader", "gutter", "columnInset",
  "icon", "iconDense", "iconMicro",
  "attachmentTile",
  "railFiles", "railActivity",
  "column", "columnResting", "measure",
  // The settings panel's content width: a 720px column is where a label, a
  // one-line note and a 200px control sit with room between and nothing wraps.
  "settingsMeasure",
] as const

test("declares exactly the roster, no more and no fewer", () => {
  expect([...tokens.keys()].sort()).toEqual([...TOKENS].sort())
})

/**
 * The one measurement that has to be written twice.
 *
 * The window is drawn with `titleBarStyle: "hidden"` and a native overlay for
 * the caption buttons, and that overlay's height is set in the main process —
 * which cannot read a StyleX variable, because the token is a CSS custom
 * property that only exists once Chromium has parsed the renderer's stylesheet.
 * So the number appears in `main/window.ts` as a literal, and the two have to
 * agree by hand.
 *
 * A mismatch is not a crash and not a test failure anywhere else: the native
 * buttons simply sit at a different height from the strip they are drawn into,
 * which reads as a step at the top-right corner of the window and is invisible
 * to everything but a person looking at it. This is that person.
 */
test("the native title bar overlay is exactly as tall as the tab strip", async () => {
  const window = await Bun.file(new URL("../../main/window.ts", import.meta.url)).text()
  const overlay = /titleBarOverlay:[\s\S]*?height: (\d+),/.exec(window)
  expect(overlay, "window.ts still sets a titleBarOverlay height").not.toBeNull()
  expect(Number(overlay![1])).toBe(px("tabStrip"))
})
