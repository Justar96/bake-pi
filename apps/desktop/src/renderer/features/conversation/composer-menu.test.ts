import { expect, test } from "bun:test"
import { MIN_CONVERSATION } from "../workbench/layout.ts"

/**
 * The chooser menus have to stay inside the composer, and the numbers deciding
 * whether they do are in two files that cannot read each other.
 *
 * `styles.choiceMenu` un-sets the `insetInline: 0` it inherits from
 * `styles.menu`, because a chooser anchors to its own chip rather than to the
 * composer's full width. That is correct and it is also what removed the only
 * thing keeping the menu inside the box: an absolutely positioned element
 * anchored to one edge grows in one direction until its `max-width` stops it,
 * and nothing clips it — the workbench is `position: fixed`, so a menu past the
 * composer is a menu past the window, clipped by the viewport with no scrollbar
 * to recover it.
 *
 * So the cap has to be small enough to fit the narrowest composer the layout
 * can produce, which is the conversation floor in `layout.ts` less the two
 * gutters in `sizes.stylex.ts`. Both are read as text here for the same reason
 * the other theme tests do it: a `.stylex.ts` module throws without the Babel
 * plugin, and the bytes the compiler reads are the ones worth asserting.
 */
const composerSource = await Bun.file(new URL("./Composer.tsx", import.meta.url)).text()
const sizesSource = await Bun.file(new URL("../../theme/sizes.stylex.ts", import.meta.url)).text()

const declaration = (style: string): string => {
  const match = new RegExp(`^\\s{2}${style}: \\{[^}]*\\}`, "m").exec(composerSource)
  expect(match, `${style} is declared on one line`).not.toBeNull()
  return match![0]
}

const pixels = (source: string, property: string): number => {
  const match = new RegExp(`${property}:\\s*"(\\d+)px"`).exec(source)
  expect(match, `${property} is a pixel literal`).not.toBeNull()
  return Number.parseInt(match![1]!, 10)
}

/**
 * The composer's inset is `columnInset`, a `clamp(min, percent, max)` of the
 * pane, so its value at the conversation floor is the clamp evaluated there.
 */
const insetAt = (paneWidth: number): number => {
  const match = /columnInset:\s*"clamp\((\d+)px, (\d+(?:\.\d+)?)%, (\d+)px\)"/.exec(sizesSource)
  expect(match, "columnInset is a clamp of px, percent, px").not.toBeNull()
  const [, min, percent, max] = match!
  return Math.max(Number(min), Math.min(Number(max), (paneWidth * Number(percent)) / 100))
}
/** Both insets come off the conversation column before the composer gets it. */
const NARROWEST_COMPOSER = MIN_CONVERSATION - 2 * insetAt(MIN_CONVERSATION)

test("a chooser menu fits the narrowest composer the layout can produce", () => {
  expect(pixels(declaration("choiceMenu"), "maxWidth")).toBeLessThanOrEqual(NARROWEST_COMPOSER)
})
