import { describe, expect, test } from "bun:test"

/**
 * Contrast as arithmetic rather than as intent.
 *
 * Three themes times thirty-odd roles is more pairings than anyone checks by
 * looking, and the ones that go wrong are never the obvious ones — nobody ships
 * white-on-white. What ships is a muted caption that was legible on the canvas
 * and is not on the overlay two steps above it, or a status colour tuned
 * against the wrong background because the two were the same value when it was
 * chosen.
 *
 * This is also what makes the borderless direction safe to hold. With outlines
 * gone, every boundary in the interface is a difference between two fills, so
 * the difference has to be a number somebody asserted rather than a shade
 * somebody liked.
 *
 * The thresholds are WCAG 2.2: 4.5 for body text, 3.0 for large text and for
 * the non-text boundaries a control is recognised by.
 */

/**
 * The palettes are read out of `tokens.stylex.ts` as text, which is the one way
 * to get at them.
 *
 * They cannot be imported: that module calls `stylex.defineVars`, which throws
 * the moment it runs without the Babel plugin, and `bun test` has no plugin.
 * They cannot live in a neighbouring module either — the StyleX compiler folds
 * these calls at build time and rejects a value it cannot see in the literal,
 * so the palette has to be written inline or the build fails.
 *
 * That leaves reading the source. It is less comfortable than an import, and it
 * buys the thing that matters: these ratios are measured over the same bytes
 * the compiler turns into CSS, not over a copy that agreed with them once.
 */
const source = await Bun.file(new URL("./tokens.stylex.ts", import.meta.url)).text()

/** Every colour role, named once here so a theme cannot quietly drop one. */
const ROLES = [
  "canvas", "canvasSubtle", "surface", "surfaceRaised", "surfaceOverlay", "sunken",
  "text", "textMuted", "textFaint",
  "accent", "accentHover", "accentSoft", "accentOn",
  "running", "runningSoft",
  "success", "successSoft", "warning", "warningSoft", "danger", "dangerSoft",
  "reasoning", "reasoningSoft",
  "diffAdded", "diffAddedSoft", "diffRemoved", "diffRemovedSoft",
  "selection", "selectionText",
  "border", "borderStrong", "focus",
] as const

type Role = (typeof ROLES)[number]
type Palette = Record<Role, string>

/**
 * Pull the colours out of one declaration.
 *
 * Deliberately narrow: it takes the text from the opening of the named call to
 * the first `\n})`, and inside that it matches only `role: "#rrggbb"`. Anything
 * it cannot understand — a computed value, a colour written some other way —
 * comes out as a missing role, and the completeness test below fails loudly
 * rather than the ratios being measured over a half-read palette.
 */
const parse = (declaration: string): Palette => {
  const start = source.indexOf(declaration)
  if (start === -1) throw new Error(`${declaration} is no longer in tokens.stylex.ts`)
  const body = source.slice(start, source.indexOf("\n})", start))
  const palette: Partial<Palette> = {}
  for (const [, role, value] of body.matchAll(/^ {2}(\w+): "(#[0-9a-f]{6})",$/gm)) {
    palette[role as Role] = value!
  }
  return palette as Palette
}

const dark = parse("export const colors = stylex.defineVars({")
const themes: [string, Palette][] = [
  ["dark", dark],
  // Dark is the declaration every theme overrides, so a theme that leaves a
  // role alone inherits it — which is exactly what `darkTheme` does with all
  // of them, and what the light and high-contrast themes do with none.
  ["light", { ...dark, ...parse("export const lightTheme = stylex.createTheme(colors, {") }],
  ["high-contrast", { ...dark, ...parse("export const highContrastTheme = stylex.createTheme(colors, {") }],
]
const palettes = Object.fromEntries(themes) as Record<string, Palette>

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

/** Every surface a person reads text on, which is what "readable" has to mean. */
const SUBSTRATES = ["canvas", "canvasSubtle", "surface", "surfaceRaised", "surfaceOverlay", "sunken"] as const

describe.each(themes)("%s meets the contrast it claims", (_name, palette) => {
  test("body text is readable on every surface it can be drawn on", () => {
    for (const substrate of SUBSTRATES) {
      expect({ substrate, ok: ratio(palette.text, palette[substrate]) >= 4.5 }).toEqual({ substrate, ok: true })
    }
  })

  test("muted text is readable on every surface, because it is text and not decoration", () => {
    // `textMuted` carries session metadata, timestamps and the connection
    // status — things a person reads rather than glances at. Holding it to the
    // body threshold is the decision; the alternative is a caption that is
    // technically compliant and practically squinted at.
    for (const substrate of SUBSTRATES) {
      expect({ substrate, ok: ratio(palette.textMuted, palette[substrate]) >= 4.5 }).toEqual({ substrate, ok: true })
    }
  })

  test("faint text clears the large-text threshold wherever it is used", () => {
    // `textFaint` is line numbers, diff gutters and hint text: never the only
    // way something is said, and never the thing being read. Held to 3.0 on the
    // substrates it actually appears on — the composer menu's hints and footer
    // sit on the overlay — rather than to 4.5 everywhere, which would collapse
    // it into `textMuted` and lose the distinction.
    for (const substrate of ["canvas", "canvasSubtle", "surface", "surfaceOverlay", "sunken"] as const) {
      expect({ substrate, ok: ratio(palette.textFaint, palette[substrate]) >= 3 }).toEqual({ substrate, ok: true })
    }
  })

  test("the accent is readable as link text, and its own label is readable on it", () => {
    for (const substrate of ["canvas", "surface", "surfaceRaised"] as const) {
      expect({ substrate, ok: ratio(palette.accent, palette[substrate]) >= 4.5 }).toEqual({ substrate, ok: true })
    }
    expect(ratio(palette.accentOn, palette.accent)).toBeGreaterThanOrEqual(4.5)
    // A selected choice-menu row is a wash of `accentSoft` carrying a body-text
    // label and a faint hint, so both pairings are asserted rather than assumed.
    expect(ratio(palette.text, palette.accentSoft)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(palette.textFaint, palette.accentSoft)).toBeGreaterThanOrEqual(3)
    // `accentSoft` is also the hover fill of every list row, and a row carries a
    // muted path under its name — text, at the body threshold, on a fill that
    // only appears under the pointer and so is easy to leave unmeasured.
    expect(ratio(palette.textMuted, palette.accentSoft)).toBeGreaterThanOrEqual(4.5)
  })

  test("every status colour is readable on its own soft background", () => {
    // The pairing that is actually rendered: a status word tinted with the role
    // colour, sitting on the role's soft fill. Checking each against the canvas
    // instead — which is the easy thing to check — would pass a badge whose
    // text vanishes into its own chip.
    const pairs = [
      ["running", "runningSoft"],
      ["success", "successSoft"],
      ["warning", "warningSoft"],
      ["danger", "dangerSoft"],
      ["reasoning", "reasoningSoft"],
      ["accent", "accentSoft"],
    ] as const
    for (const [role, soft] of pairs) {
      expect({ role, ok: ratio(palette[role], palette[soft]) >= 4.5 }).toEqual({ role, ok: true })
    }
  })

  test("status colours are readable on the canvas and on a modal", () => {
    // Two substrates, not one. A status word is drawn on the page and again
    // inside a dialog, and `surfaceOverlay` is two steps up from the canvas —
    // which is enough to lose a colour that passed at the bottom of the ladder.
    // `danger` was exactly that: 5.94 on the canvas, 4.46 on the overlay, and
    // an error message is read in a modal more often than anywhere else.
    for (const role of ["running", "success", "warning", "danger", "reasoning"] as const) {
      for (const substrate of ["canvas", "surfaceOverlay"] as const) {
        expect({ role, substrate, ok: ratio(palette[role], palette[substrate]) >= 4.5 }).toEqual({ role, substrate, ok: true })
      }
    }
  })

  test("a status colour stays readable on the fill a hover puts under it", () => {
    // The composer's permission chip is a tinted word on the canvas that takes
    // `surfaceOverlay` while a pointer is on it — it lost its soft seat, and
    // with it the flat fill that used to keep hover from reaching the word.
    // This is the third and last substrate a hued word is drawn on; asserting
    // it is what makes dropping the seat a safe change rather than a hopeful
    // one.
    for (const role of ["running", "success", "warning", "danger", "reasoning"] as const) {
      expect({ role, ok: ratio(palette[role], palette.surfaceOverlay) >= 4.5 }).toEqual({ role, ok: true })
    }
  })

  test("nothing outside status and diffs carries a hue", () => {
    // The chrome is grey, and this is the line that keeps it that way. Status
    // and diff roles are the deliberate exception: they carry hue because a
    // failure and a thought need to be told apart at a glance. Everything else
    // stays neutral, so one tinted surface cannot argue its way in.
    const HUED = new Set<Role>([
      "running", "runningSoft", "success", "successSoft", "warning", "warningSoft",
      "danger", "dangerSoft", "reasoning", "reasoningSoft",
      "diffAdded", "diffAddedSoft", "diffRemoved", "diffRemovedSoft",
    ])
    for (const role of ROLES) {
      if (HUED.has(role)) continue
      const [, red, green, blue] = /^#(\w{2})(\w{2})(\w{2})$/.exec(palette[role]) ?? []
      expect({ role, neutral: red === green && green === blue }).toEqual({ role, neutral: true })
    }
  })

  test("diff tinting is legible for both the marker and the code inside the row", () => {
    // Two separate claims. The marker colour has to be readable on its own row
    // fill, and body text has to stay readable on that fill, because the code
    // in the row is drawn on it.
    expect(ratio(palette.diffAdded, palette.diffAddedSoft)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(palette.diffRemoved, palette.diffRemovedSoft)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(palette.text, palette.diffAddedSoft)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(palette.text, palette.diffRemovedSoft)).toBeGreaterThanOrEqual(4.5)
  })

  test("a selection keeps its text readable", () => {
    expect(ratio(palette.selectionText, palette.selection)).toBeGreaterThanOrEqual(4.5)
  })

  test("focus is visible against every surface it can land on", () => {
    // 3.0 rather than 4.5: a focus indicator is a non-text boundary, and it is
    // what has to be seen rather than read.
    for (const substrate of SUBSTRATES) {
      expect({ substrate, ok: ratio(palette.focus, palette[substrate]) >= 3 }).toEqual({ substrate, ok: true })
    }
  })
})

/**
 * Each theme lifts by exactly one mechanism, and this is where it says which.
 *
 * Dark separates surfaces by tint: each step adds light, and if the steps ever
 * collapse the interface loses every boundary it has, because there is nothing
 * else drawing one. Light and high contrast deliberately do *not* lift by tint
 * — light flattens to white and lets shadow carry the depth, high contrast
 * gives every surface a real outline through `hairline` — so for those two the
 * assertion is the inverse: a tint step would be a second, competing mechanism
 * rather than a bonus.
 *
 * 1.06 is not a WCAG number; no standard governs surface-to-surface separation.
 * It is the smallest ratio that still reads as a step at these lightnesses, and
 * naming it here is what stops the dark ladder collapsing one quiet palette
 * edit at a time.
 */
describe("each theme lifts by the one mechanism it declares", () => {
  const LIFTS = [
    ["canvas", "surface"],
    ["surface", "surfaceRaised"],
    ["surfaceRaised", "surfaceOverlay"],
  ] as const

  test("dark separates every lift by tint", () => {
    for (const [below, above] of LIFTS) {
      const step = `${below}→${above}`
      expect({ step, ok: ratio(palettes.dark![below], palettes.dark![above]) >= 1.06 }).toEqual({ step, ok: true })
    }
  })

  test.each([["light"], ["high-contrast"]] as const)("%s leaves the lifting to shadow or to outline", (name) => {
    for (const [below, above] of LIFTS.slice(1)) {
      expect(ratio(palettes[name]![below], palettes[name]![above])).toBeLessThan(1.1)
    }
  })

  test("every theme defines every role, so a palette cannot silently inherit one", () => {
    // Also the guard on the parser above: a role it failed to read is a role
    // missing from the palette, and this is where that surfaces.
    for (const [name, palette] of themes) {
      expect({ name, roles: Object.keys(palette).sort() }).toEqual({ name, roles: [...ROLES].sort() })
      for (const [role, value] of Object.entries(palette)) {
        expect({ name, role, value }).toEqual({ name, role, value: expect.stringMatching(/^#[0-9a-f]{6}$/) })
      }
    }
  })
})
