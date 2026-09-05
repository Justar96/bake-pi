import type { ExtensionUiRequest } from "@bake-pi/contract"

/**
 * The keyboard model of an extension question, as arithmetic.
 *
 * A group of buttons with `role="radio"` promises the behaviour a native radio
 * group has and implements none of it: the browser gives arrow keys, wrapping,
 * Home and End to `<input type="radio">` and to nothing else. The question card
 * cannot use inputs — an option row carries a mark, a label and a shortcut hint
 * — so the promise has to be kept here, and kept where it can be tested rather
 * than in a component no test in this codebase can render.
 */

/**
 * Where a key press moves the selection, or `undefined` when the key is not
 * ours to take.
 *
 * Arrows wrap, because a native radio group wraps: at the last option, down
 * goes to the first. Digits are the same movement by another route — a person
 * who can see nine numbered rows should not have to press down eight times —
 * and a digit past the end of the list is not a key this group answers, so it
 * falls through to whatever else the window does with it.
 *
 * Movement is also selection, again because that is what a radio group does.
 * The alternative, focus that moves without choosing, means every answer costs
 * an arrow key and then a space, and it is the model people already have for
 * these three roles.
 */
export const optionKeyTarget = (key: string, focused: number, count: number): number | undefined => {
  if (count <= 0) return undefined
  if (key === "ArrowDown" || key === "ArrowRight") return (focused + 1) % count
  if (key === "ArrowUp" || key === "ArrowLeft") return (focused - 1 + count) % count
  if (key === "Home") return 0
  if (key === "End") return count - 1
  if (!/^[1-9]$/.test(key)) return undefined
  const index = Number(key) - 1
  return index < count ? index : undefined
}

/**
 * The digit that answers an option row, for the hint drawn on it.
 *
 * Nine, because there is no tenth single key press: `10` is two of them, and a
 * hint that cannot be pressed as it is written is worse than no hint. Rows past
 * the ninth are still reachable by arrow, which is what the hints on the first
 * nine teach.
 */
export const optionShortcut = (index: number): string | undefined =>
  index < 9 ? String(index + 1) : undefined

/**
 * Whether this Enter sends the answer.
 *
 * Every kind but the editor sends on a bare Enter, which is the composer's rule
 * and the one a person arrives with. The editor is the one place it is wrong:
 * the request hands over a document — often several lines of `initialText`
 * already — and Enter is how a person breaks a line in it. So there the send is
 * the modified press, and the footer says so rather than leaving it to be
 * discovered.
 */
export const answersOnEnter = (kind: ExtensionUiRequest["kind"], modified: boolean): boolean =>
  kind === "editor" ? modified : !modified
