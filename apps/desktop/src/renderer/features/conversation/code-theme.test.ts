import { describe, expect, test } from "bun:test"
import type { Appearance } from "../../theme/appearance.ts"
import { CODE_THEMES, RAMPS } from "./code-theme.ts"

/**
 * The code themes, held to the same arithmetic as the interface palette.
 *
 * `theme/contrast.test.ts` cannot reach these: it reads `tokens.stylex.ts` as
 * text, because a `.stylex.ts` module cannot be imported without the Babel
 * plugin. This one is a plain module, so it is imported and measured directly —
 * same thresholds, same reasoning, different mechanism.
 */

/** WCAG relative luminance. The 0.03928 knee and the 2.4 exponent are the specification's. */
const luminance = (hex: string): number => {
  const value = hex.replace("#", "")
  const channel = (offset: number): number => {
    const raw = Number.parseInt(value.slice(offset, offset + 2), 16) / 255
    return raw <= 0.03928 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
}

const ratio = (a: string, b: string): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light! + 0.05) / (dark! + 0.05)
}

// Mutable rather than `as const`: `describe.each` takes an array it may consume.
const APPEARANCES: Appearance[] = ["light", "dark", "high-contrast"]
const ROLES = ["plain", "punctuation", "comment", "string", "literal", "name", "keyword"] as const

/**
 * `ramp.background` is the ground the measurements above run over; `sunken` is
 * the ground the listing actually renders on, and the two are the same colour
 * only because this reads the token file and says so. It has to be read as
 * text for the reason `contrast.test.ts` explains: a `.stylex.ts` module
 * cannot be imported without the Babel plugin. A theme that stops overriding
 * `sunken` inherits dark's — the same fallthrough the palettes themselves use.
 */
const tokens = await Bun.file(new URL("../../theme/tokens.stylex.ts", import.meta.url)).text()
const sunkenIn = (declaration: string): string | undefined => {
  const start = tokens.indexOf(declaration)
  if (start === -1) throw new Error(`${declaration} is no longer in tokens.stylex.ts`)
  return /sunken: "(#[0-9a-f]{6})"/.exec(tokens.slice(start, tokens.indexOf("\n})", start)))?.[1]
}
const darkSunken = sunkenIn("export const colors = stylex.defineVars({")
if (darkSunken === undefined) throw new Error("sunken is no longer in tokens.stylex.ts")
const SUNKEN: Record<Appearance, string> = {
  dark: darkSunken,
  light: sunkenIn("export const lightTheme = stylex.createTheme(colors, {") ?? darkSunken,
  "high-contrast": sunkenIn("export const highContrastTheme = stylex.createTheme(colors, {") ?? darkSunken,
}

describe.each(APPEARANCES)("the %s code theme", (appearance) => {
  const ramp = RAMPS[appearance]

  test("every role is readable on the fill code is drawn on", () => {
    // 4.5 for all seven, comments included. A comment is prose somebody wrote
    // to be read; holding it to the large-text threshold instead is how a
    // codebase ends up with documentation nobody can see.
    for (const role of ROLES) {
      expect({ role, ok: ratio(ramp[role], ramp.background) >= 4.5 }).toEqual({ role, ok: true })
    }
  })

  test("comments stay quieter than plain code, and the background stays grey", () => {
    // Hue does the separating between roles now, so no ordering is asserted
    // across them — only that a comment never outshines the code it annotates,
    // and that the ground under the listing is still the neutral `sunken` fill.
    const away = (hex: string): number => ratio(hex, ramp.background)
    expect(away(ramp.comment)).toBeLessThanOrEqual(away(ramp.plain))
    const [, r, g, b] = /^#(\w{2})(\w{2})(\w{2})$/.exec(ramp.background) ?? []
    expect(r === g && g === b).toBe(true)
  })

  test("its background is the sunken fill the listing renders on", () => {
    expect(ramp.background).toBe(SUNKEN[appearance])
  })

  test("the theme names itself, because the highlighter is keyed by name", () => {
    // `highlight.ts` registers a theme once and then asks for it by name. Two
    // appearances sharing one would silently draw the second in the first's
    // ramp, which is exactly the kind of bug that looks like a caching problem.
    expect(CODE_THEMES[appearance].name).toBe(`bakepi-${appearance}`)
  })
})

test("no two appearances share a theme name", () => {
  const names = APPEARANCES.map((appearance) => CODE_THEMES[appearance].name)
  expect(new Set(names).size).toBe(names.length)
})
