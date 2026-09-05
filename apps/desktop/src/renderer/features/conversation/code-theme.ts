import type { ThemeRegistrationRaw } from "shiki/core"
import type { Appearance } from "../../theme/appearance.ts"

/**
 * Syntax highlighting, in the same VS Code theme format Shiki wants and
 * Milestone 4's importer will accept.
 *
 * Hue is the first axis: strings green, literals blue, names yellow, keywords
 * violet, so a reader who sees colour can tell the roles apart without reading
 * them. Font style is the second: comments are italic and keywords are bold, so
 * the two roles that matter most are separated by shape as well and survive a
 * screenshot, a projector, or a reader who cannot tell two hues apart.
 *
 * The scopes below collapse onto six roles rather than one colour per token
 * type — a dozen hues on one line stop being read and start being noise — and
 * anything a grammar emits outside them falls back to the plain foreground,
 * which is the right failure: legible, just unmarked.
 *
 * Every value is asserted against the substrate it is drawn on in
 * `code-theme.test.ts`. Code blocks sit on `sunken`, so that — not the canvas —
 * is the background each ramp is measured over.
 */

/** The six roles every scope below collapses onto. */
interface Ramp {
  /** Plain identifiers, operators, anything the grammar did not classify. */
  plain: string
  /** Punctuation and delimiters: structure a reader skims rather than reads. */
  punctuation: string
  /** Comments. The quietest role, and the only italic one. */
  comment: string
  /** Strings and their embedded escapes. */
  string: string
  /** Literals and named constants — the values in the code. */
  literal: string
  /** Names: functions, types, classes, tags. */
  name: string
  /** Keywords and storage. The only bold role. */
  keyword: string
  /** The `sunken` fill these are drawn on, kept here so the test can assert it. */
  background: string
}

const DARK: Ramp = {
  plain: "#d4d4d4",
  punctuation: "#9a9a9a",
  comment: "#8b949e",
  string: "#98c379",
  literal: "#79b8ff",
  name: "#e5c07b",
  keyword: "#d2a8ff",
  background: "#0c0c0c",
}

const LIGHT: Ramp = {
  plain: "#24292f",
  punctuation: "#57606a",
  comment: "#5f6b76",
  string: "#116329",
  literal: "#0550ae",
  name: "#6f42c1",
  keyword: "#cf222e",
  background: "#ededed",
}

/**
 * High contrast keeps the same hues but lifts every one of them well clear of
 * the black ground, so ink-from-ground never competes with role-from-role. Bold
 * and italic still carry the two roles that matter most, which is the correct
 * trade for a theme somebody chose because tone alone was not reaching them.
 */
const HIGH_CONTRAST: Ramp = {
  plain: "#ffffff",
  punctuation: "#d4d4d4",
  comment: "#b4c2d0",
  string: "#a6e3a1",
  literal: "#89b4fa",
  name: "#f9e2af",
  keyword: "#cba6f7",
  background: "#000000",
}

export const RAMPS: Record<Appearance, Ramp> = { light: LIGHT, dark: DARK, "high-contrast": HIGH_CONTRAST }

/**
 * Scopes are listed most general first, because TextMate resolution is
 * last-match-wins: a rule further down overrides one above it for the same
 * token. So `punctuation` can be dimmed wholesale and
 * `punctuation.definition.string` still pulled back up to the string tone,
 * which is what stops a quoted string looking like it has holes at both ends.
 */
type NamedTheme = ThemeRegistrationRaw & { name: string }

const build = (name: string, type: "light" | "dark", ramp: Ramp): NamedTheme => ({
  name,
  type,
  colors: { "editor.foreground": ramp.plain, "editor.background": ramp.background },
  settings: [
    { settings: { foreground: ramp.plain, background: ramp.background } },

    { scope: ["punctuation", "meta.brace", "meta.delimiter"], settings: { foreground: ramp.punctuation } },

    { scope: ["comment", "punctuation.definition.comment", "string.comment"], settings: { foreground: ramp.comment, fontStyle: "italic" } },

    { scope: ["string", "constant.other.symbol", "punctuation.definition.string", "meta.embedded.assembly"], settings: { foreground: ramp.string } },
    { scope: ["constant.character.escape", "string.regexp"], settings: { foreground: ramp.literal } },

    { scope: ["constant", "constant.numeric", "constant.language", "variable.other.constant", "support.constant"], settings: { foreground: ramp.literal } },

    { scope: ["entity.name.function", "support.function", "meta.function-call.generic", "entity.name.tag", "entity.name.type", "entity.name.class", "entity.name.namespace", "support.type", "support.class", "variable.function"], settings: { foreground: ramp.name } },
    { scope: ["entity.other.attribute-name", "variable.parameter", "variable.other.property", "meta.object-literal.key"], settings: { foreground: ramp.string } },

    { scope: ["keyword", "storage", "storage.type", "storage.modifier", "keyword.control", "keyword.operator.expression", "keyword.operator.new", "variable.language", "entity.name.tag.yaml", "markup.heading"], settings: { foreground: ramp.keyword, fontStyle: "bold" } },

    { scope: ["invalid", "invalid.illegal"], settings: { foreground: ramp.keyword, fontStyle: "bold underline" } },
    { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
    { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
    { scope: ["markup.inserted"], settings: { foreground: ramp.name } },
    { scope: ["markup.deleted"], settings: { foreground: ramp.string } },
  ],
})

export const CODE_THEMES: Record<Appearance, NamedTheme> = {
  light: build("bakepi-light", "light", LIGHT),
  dark: build("bakepi-dark", "dark", DARK),
  "high-contrast": build("bakepi-high-contrast", "dark", HIGH_CONTRAST),
}
