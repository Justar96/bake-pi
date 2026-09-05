/**
 * A line diff for an edit the model described as text, not as a patch.
 *
 * Pi's `edit` tool takes `oldText` and `newText`. Showing that as "every old
 * line deleted, every new line added" makes a one-line change inside a
 * ten-line block look like a rewrite of the block, which is the same failure
 * the word-level pieces exist to prevent one level down. The unchanged lines
 * are context, and only the lines that differ are the change.
 *
 * The algorithm is the ordinary LCS over lines, after the common head and tail
 * have been peeled off — an edit almost always changes something in the middle
 * of what it quotes, so the quadratic part usually runs over a handful of
 * lines. Past the cap it gives up and reports the whole block as replaced,
 * because a diff of two hundred lines against two hundred is a listing nobody
 * reads line by line anyway.
 */

export type LineChange = "ctx" | "del" | "add"

export interface DiffLine {
  type: LineChange
  text: string
}

const CAP = 300

export const lineDiff = (before: string[], after: string[]): DiffLine[] => {
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1
  let tail = 0
  while (
    tail < before.length - head && tail < after.length - head
    && before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) tail += 1

  const oldMiddle = before.slice(head, before.length - tail)
  const newMiddle = after.slice(head, after.length - tail)
  const out: DiffLine[] = before.slice(0, head).map((text) => ({ type: "ctx", text }))

  if (oldMiddle.length > CAP || newMiddle.length > CAP) {
    for (const text of oldMiddle) out.push({ type: "del", text })
    for (const text of newMiddle) out.push({ type: "add", text })
  } else {
    // lengths[i][j] = LCS length of oldMiddle[i..] and newMiddle[j..]
    const lengths: number[][] = Array.from({ length: oldMiddle.length + 1 }, () => new Array<number>(newMiddle.length + 1).fill(0))
    for (let i = oldMiddle.length - 1; i >= 0; i -= 1) {
      for (let j = newMiddle.length - 1; j >= 0; j -= 1) {
        lengths[i]![j] = oldMiddle[i] === newMiddle[j]
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!)
      }
    }
    let i = 0
    let j = 0
    while (i < oldMiddle.length || j < newMiddle.length) {
      if (i < oldMiddle.length && j < newMiddle.length && oldMiddle[i] === newMiddle[j]) {
        out.push({ type: "ctx", text: oldMiddle[i]! })
        i += 1
        j += 1
      } else if (j >= newMiddle.length || (i < oldMiddle.length && lengths[i + 1]![j]! >= lengths[i]![j + 1]!)) {
        // Deletions before additions when either would do, so a replaced
        // line reads old-then-new the way a patch does.
        out.push({ type: "del", text: oldMiddle[i]! })
        i += 1
      } else {
        out.push({ type: "add", text: newMiddle[j]! })
        j += 1
      }
    }
  }

  for (const text of before.slice(before.length - tail)) out.push({ type: "ctx", text })
  return out
}
