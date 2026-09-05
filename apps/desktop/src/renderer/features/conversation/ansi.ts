import type { Appearance } from "../../theme/appearance.ts"
import { RAMPS } from "./code-theme.ts"
import type { Token } from "./highlight.ts"

/**
 * Terminal output, with its escape codes honoured rather than shown.
 *
 * A shell tool returns what the process wrote, and processes write SGR codes:
 * `tsc` underlines, `bun test` paints pass and fail, `git` colours a diff. Left
 * in, they are `[31m` litter in front of every word that mattered; stripped,
 * the emphasis the process chose is gone with them. This keeps the emphasis
 * and drops the litter.
 *
 * The palette is grey, so the eight ANSI colours cannot be eight hues here.
 * They land on the code theme's ramp by how much a process usually means by
 * them: red and magenta on the brightest role because they are how failure is
 * announced, yellow and green on the next two, the rest on the plain tone.
 * Bold and dim carry through as weight and as the comment tone. Lightness alone
 * does not name a state — the theme file says so at length — and it does not
 * have to: the process wrote the word beside the colour.
 */

const SGR = /\[([\d;]*)m/g
/** Anything else a terminal would swallow: cursor movement, OSC titles, hyperlinks. */
const OTHER_ESCAPES = /(?:\[[\d;?]*[A-Za-ln-z]|\][^]*(?:|\\)|[()][A-Za-z0-9])/g

interface Pen {
  color: "plain" | "comment" | "string" | "literal" | "name" | "keyword" | undefined
  bold: boolean
  italic: boolean
  underline: boolean
}

const RESET: Pen = { color: undefined, bold: false, italic: false, underline: false }

const colorFor = (code: number): Pen["color"] => {
  switch (code % 60) {
    case 31: case 35: return "keyword"
    case 33: return "literal"
    case 32: return "name"
    case 36: case 34: return "string"
    case 30: case 37: default: return "plain"
  }
}

const apply = (pen: Pen, codes: number[]): Pen => {
  let next = { ...pen }
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index]!
    if (code === 0) next = { ...RESET }
    else if (code === 1) next.bold = true
    else if (code === 2) next.color = "comment"
    else if (code === 3) next.italic = true
    else if (code === 4) next.underline = true
    else if (code === 22) { next.bold = false; if (next.color === "comment") next.color = undefined }
    else if (code === 23) next.italic = false
    else if (code === 24) next.underline = false
    else if (code === 39) next.color = undefined
    else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) next.color = colorFor(code)
    // 256-colour and truecolour foregrounds take extra parameters; skip them
    // and keep whatever tone was in force. Backgrounds (40–47, 100–107) are
    // ignored outright — the listing has one substrate.
    else if (code === 38 || code === 48) index += codes[index + 1] === 5 ? 2 : codes[index + 1] === 2 ? 4 : 0
  }
  return next
}

export const hasAnsi = (text: string): boolean => text.includes("")

/** Every code stripped, for copying and for counting. */
export const stripAnsi = (text: string): string => text.replace(SGR, "").replace(OTHER_ESCAPES, "")

/** One token list per line, in the same shape the syntax highlighter emits. */
export const ansiTokens = (text: string, appearance: Appearance): Token[][] => {
  const ramp = RAMPS[appearance]
  const lines: Token[][] = [[]]
  let pen: Pen = { ...RESET }
  const push = (run: string): void => {
    const parts = run.split("\n")
    parts.forEach((part, index) => {
      if (index > 0) lines.push([])
      if (part.length === 0) return
      lines[lines.length - 1]!.push({
        text: part,
        color: pen.color === undefined ? undefined : ramp[pen.color],
        bold: pen.bold,
        italic: pen.italic,
        underline: pen.underline,
      })
    })
  }
  const clean = text.replace(OTHER_ESCAPES, "")
  let last = 0
  for (const match of clean.matchAll(SGR)) {
    push(clean.slice(last, match.index))
    pen = apply(pen, match[1] === "" ? [0] : match[1]!.split(";").map((part) => Number.parseInt(part, 10) || 0))
    last = match.index + match[0].length
  }
  push(clean.slice(last))
  if (lines.length > 1 && lines.at(-1)!.length === 0) lines.pop()
  return lines
}
