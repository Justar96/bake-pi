/**
 * Word-level pieces inside a unified-diff row.
 *
 * A whole-line tint is enough to say that a row changed. It is not enough to
 * say *what* changed: `temp: "-14C"` becoming `temp: "-16C"` is one token, and
 * colouring the rest of the line with it makes every edit look like a rewrite.
 * Pairing a deleted row with the added row that replaced it, then marking only
 * the tokens that actually differ, is what the fluid code-block does — and it
 * is why the pieces live next to the row rather than replacing it.
 *
 * The algorithm is LCS over a split that keeps whitespace as its own tokens,
 * so a change of one identifier does not swallow the spaces around it. Above a
 * few hundred tokens it gives up and treats the whole line as the change:
 * quadratic matching on a minified line would stall the renderer for a
 * highlight nobody can read at that length anyway.
 */

export type ChangeMark = "add" | "del"

export interface CodePiece {
  text: string
  change?: ChangeMark
}

const TOKEN = /(\s+|[^\s]+)/g
const CAP = 400

const split = (text: string): string[] => text.match(TOKEN) ?? (text.length === 0 ? [] : [text])

/**
 * Longest common subsequence as a boolean mask on each side.
 *
 * DP tables are built for the token arrays, then walked back from the end so
 * the result is the actual matching set rather than only its length. That is
 * the whole of the algorithm: tokens that are not in the match are the ones
 * the row should tint.
 */
const matched = (left: string[], right: string[]): { inLeft: boolean[]; inRight: boolean[] } => {
  const rows = left.length
  const cols = right.length
  const table: number[][] = Array.from({ length: rows + 1 }, () => Array.from({ length: cols + 1 }, () => 0))
  for (let i = 1; i <= rows; i += 1) {
    for (let j = 1; j <= cols; j += 1) {
      table[i]![j] = left[i - 1] === right[j - 1]
        ? table[i - 1]![j - 1]! + 1
        : Math.max(table[i - 1]![j]!, table[i]![j - 1]!)
    }
  }
  const inLeft = Array.from({ length: rows }, () => false)
  const inRight = Array.from({ length: cols }, () => false)
  let i = rows
  let j = cols
  while (i > 0 && j > 0) {
    if (left[i - 1] === right[j - 1]) {
      inLeft[i - 1] = true
      inRight[j - 1] = true
      i -= 1
      j -= 1
    } else if (table[i - 1]![j]! >= table[i]![j - 1]!) {
      i -= 1
    } else {
      j -= 1
    }
  }
  return { inLeft, inRight }
}

const paint = (tokens: string[], keep: boolean[], change: ChangeMark): CodePiece[] => {
  const pieces: CodePiece[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const text = tokens[index]!
    const mark = keep[index] === true ? undefined : change
    const last = pieces.at(-1)
    if (last !== undefined && last.change === mark) last.text += text
    else pieces.push(mark === undefined ? { text } : { text, change: mark })
  }
  return pieces
}

/** Pieces for a deleted line and the added line that replaced it. */
export const diffPieces = (before: string, after: string): { del: CodePiece[]; add: CodePiece[] } => {
  if (before === after) return { del: [{ text: before }], add: [{ text: after }] }
  const left = split(before)
  const right = split(after)
  if (left.length === 0) return { del: [], add: after.length === 0 ? [] : [{ text: after, change: "add" }] }
  if (right.length === 0) return { del: [{ text: before, change: "del" }], add: [] }
  if (left.length > CAP || right.length > CAP) {
    return { del: [{ text: before, change: "del" }], add: [{ text: after, change: "add" }] }
  }
  const { inLeft, inRight } = matched(left, right)
  return { del: paint(left, inLeft, "del"), add: paint(right, inRight, "add") }
}
