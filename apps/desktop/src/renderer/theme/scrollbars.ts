import * as stylex from "@stylexjs/stylex"
import { effects, radius } from "./tokens.stylex.ts"

/**
 * One scrollbar, worn by every scrolling surface in the workbench.
 *
 * Fluid functionalism's rule for a scrollbar is that it stays out of the way
 * until you reach for it: narrow and low-contrast at rest, wider and darker
 * under the pointer. That is the whole behaviour, and it is the opposite of
 * what the platform draws by default — a permanent grey channel with a slab in
 * it, sized for a mouse from 2003 and coloured for a window that has no other
 * chrome to compete with.
 *
 * How it is built matters, because there are two ways and only one of them
 * works here:
 *
 *   The track is ten pixels and the thumb is four, and the six pixels between
 *   them are a transparent border rather than a margin. `background-clip:
 *   content-box` keeps the fill inside that border, so the thumb *looks* four
 *   pixels wide while the whole ten remains a hit target — you can throw the
 *   pointer at the window edge and still catch it. Hover narrows the border to
 *   two, which widens the visible thumb to six, and the transparent border
 *   insets the ends by the same amount, which is where the small gap at the
 *   top and bottom of the bar comes from.
 *
 *   The colour is an overlay tint, not a palette colour: eight percent at rest,
 *   twelve under the pointer, sixteen while dragged. A scrollbar sits on
 *   whatever it happens to be scrolling — a rail, a code block, a dialog — and
 *   a tint is the only thing that reads the same weight on all of them.
 *
 * What the upstream component also does and this cannot is fade the bar in on
 * *scroll*. That state has no CSS expression — Base UI publishes it as a data
 * attribute from a scroll listener — and adding a listener to every scrolling
 * element in the interface to fade a bar that is already at eight percent is a
 * poor trade. At rest this is quiet enough that there is nothing to hide.
 *
 * Applied by composition rather than globally, which is not a preference: the
 * renderer's CSP carries no `style-src 'unsafe-inline'`, so `index.html` cannot
 * hold a stylesheet, and StyleX has no universal selector to write one with.
 * Every element that scrolls names this, and the list of elements that scroll
 * is therefore the list of elements that import it.
 */
export const scrollbars = stylex.create({
  thin: {
    "::-webkit-scrollbar": { width: "10px", height: "10px" },
    "::-webkit-scrollbar-track": { backgroundColor: "transparent" },
    "::-webkit-scrollbar-corner": { backgroundColor: "transparent" },
    "::-webkit-scrollbar-thumb": {
      backgroundColor: {
        default: effects.scrollThumb,
        ":hover": effects.scrollThumbHover,
        ":active": effects.scrollThumbActive,
      },
      backgroundClip: "content-box",
      borderStyle: "solid",
      borderColor: "transparent",
      borderWidth: { default: "3px", ":hover": "2px" },
      borderRadius: radius.sm,
    },
  },
})
