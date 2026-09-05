import { expect, test } from "bun:test"

/**
 * The shimmer's rules, held as arithmetic rather than as a comment.
 *
 * A swept gradient clipped to glyphs is the one text effect in this interface
 * whose failure mode is silence: the fill is `transparent`, so anything that
 * stops the gradient from painting leaves a word that is still in the DOM,
 * still announced, and invisible. None of that is visible in a screenshot of a
 * working build either — it takes a theme, a media query, or a colour the
 * platform overrode. So the properties that keep it legible are asserted here.
 *
 * Read as text for the same reason `contrast.test.ts` reads the palette that
 * way: the module calls `stylex.create`, which throws without the Babel
 * plugin, and `bun test` has no plugin.
 *
 * Ratios are deliberately not re-measured here. `contrast.test.ts` already
 * holds `text` and `textMuted` to 4.5 on every surface and each status colour
 * to 4.5 on the canvas; what this file adds is the other half of that
 * argument — that the sweep may only be built out of those tokens. Together
 * they say the word is readable at every point of the sweep. Measuring the
 * ratios again in this file would be a second copy of a number that is only
 * true in one place.
 */
const source = await Bun.file(new URL("./shimmer.ts", import.meta.url)).text()

/**
 * The tokens `contrast.test.ts` proves a person can read.
 *
 * `textFaint` is deliberately absent: it clears 3.0, the large-text and
 * boundary threshold, which is the right bar for a diff gutter and the wrong
 * one for a word describing what the application is doing.
 */
const READABLE_ON_CANVAS = new Set(["text", "textMuted", "running", "success", "warning", "danger", "reasoning"])

/**
 * One property's value, braces balanced.
 *
 * `${colors.running}` inside the gradient contributes a matched pair, so
 * counting is enough and no template-literal special case is needed.
 */
const valueOf = (property: string): string => {
  const start = source.indexOf(`${property}: {`)
  expect({ property, declared: start !== -1 }).toEqual({ property, declared: true })
  let depth = 0
  for (let at = start + property.length + 2; at < source.length; at += 1) {
    if (source[at] === "{") depth += 1
    if (source[at] === "}") {
      depth -= 1
      if (depth === 0) return source.slice(start, at + 1)
    }
  }
  throw new Error(`${property} is never closed in shimmer.ts`)
}

/** The two conditions that must take the gradient away rather than freeze it. */
const CONDITIONS = ["[still]", "[forced]"] as const

test("the sweep is built only out of colours a person can read", () => {
  const gradient = /linear-gradient\(([^`]*)\)/.exec(source)
  expect(gradient, "the sweep is a linear gradient").not.toBeNull()
  const stops = [...gradient![1]!.matchAll(/colors\.(\w+)/g)].map(([, token]) => token!)

  // Two distinct tokens at least, or there is no sweep to see.
  expect(new Set(stops).size).toBeGreaterThanOrEqual(2)
  for (const stop of stops) {
    expect({ stop, readable: READABLE_ON_CANVAS.has(stop) }).toEqual({ stop, readable: true })
  }
})

test("a transparent fill is only ever paired with a clip that fills it", () => {
  // The two halves of one mechanism. `color: transparent` is legible only
  // because the gradient is painted into the glyphs; drop the clip and the
  // word is gone, which is why neither may be edited alone.
  expect(source).toContain("backgroundClip: \"text\"")
  expect(valueOf("color")).toContain("\"transparent\"")
})

test("reduced motion and forced colours each restore a solid colour", () => {
  const fill = valueOf("color")
  for (const condition of CONDITIONS) {
    const fallback = new RegExp(`\\${condition}: colors\\.(\\w+)`).exec(fill)
    expect({ condition, solid: fallback !== null }).toEqual({ condition, solid: true })
    const token = fallback![1]!
    expect({ condition, token, readable: READABLE_ON_CANVAS.has(token) }).toEqual({ condition, token, readable: true })
  }
})

test("both conditions drop the gradient and the animation, rather than holding them still", () => {
  // A stopped sweep is a word coloured by wherever the sweep happened to be,
  // which is not a colour anybody chose or measured.
  for (const property of ["backgroundImage", "animationName"]) {
    const value = valueOf(property)
    for (const condition of CONDITIONS) {
      expect({ property, condition, dropped: value.includes(`${condition}: "none"`) }).toEqual({ property, condition, dropped: true })
    }
  }
})

test("the sweep never slides the gradient off the text it fills", () => {
  // With a background wider than its box, 0% and 100% are the extremes that
  // still cover it. A position outside that range paints nothing into the
  // glyphs, and nothing is an invisible word.
  const positions = [...source.matchAll(/backgroundPosition: "(-?[\d.]+)% 0"/g)].map(([, value]) => Number(value))
  expect(positions.length).toBeGreaterThanOrEqual(2)
  for (const position of positions) {
    expect({ position, inside: position >= 0 && position <= 100 }).toEqual({ position, inside: true })
  }
})

test("the media conditions are the real ones", () => {
  // The keys are constants, so a typo would compile to a query that never
  // matches and a fallback that never applies — silently.
  expect(source).toContain("const still = \"@media (prefers-reduced-motion: reduce)\"")
  expect(source).toContain("const forced = \"@media (forced-colors: active)\"")
})
