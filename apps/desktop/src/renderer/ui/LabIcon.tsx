import * as stylex from "@stylexjs/stylex"
import { size } from "../theme/sizes.stylex.ts"
import { labArtwork } from "./lab-icons.ts"

/**
 * The mark of the lab behind a model or a provider, at one of the three glyph
 * sizes the app already uses.
 *
 * Every mark but one is a silhouette that inherits `currentColor`, so it takes
 * the tone of whatever text it sits beside and needs nothing from the theme —
 * which is also why it can sit in a muted caption and a chip's label without
 * two versions of itself. `scripts/lab-icons.ts` is where that is enforced.
 *
 * `undefined` draws nothing at all rather than a placeholder: unlike a file
 * row, whose icon arrives a moment after its name, an unknown provider is
 * permanently unknown, and a reserved empty box beside every row of an
 * otherwise unmarked catalogue is a column of nothing.
 */
export const LabIcon = ({ mark, size: variant = "dense" }: {
  mark: string | undefined
  size?: "icon" | "dense" | "micro"
}): React.JSX.Element | null => {
  const artwork = labArtwork(mark)
  if (artwork === undefined) return null
  return (
    <svg
      aria-hidden="true"
      // Which lab, in the DOM. StyleX class names are content hashes and every
      // glyph in the app is an `<svg>`, so this is the only thing a journey
      // assertion can name when it has to tell a lab mark from the generic one
      // beside it — the same reason the timeline carries `data-step-rail`.
      data-lab-mark={mark}
      viewBox={artwork.viewBox}
      dangerouslySetInnerHTML={{ __html: artwork.body }}
      {...stylex.props(styles.mark, SIZES[variant])}
    />
  )
}

const styles = stylex.create({
  // `fill: currentColor` is the mark's paint, since the generator strips every
  // colour a mono mark shipped with; the brand-coloured exception carries its
  // own fills and ignores this. `flex: none` keeps a mark from being squeezed
  // by the label it precedes in a row that has run out of width.
  mark: { flex: "none", fill: "currentColor" },
  icon: { width: size.icon, height: size.icon },
  dense: { width: size.iconDense, height: size.iconDense },
  micro: { width: size.iconMicro, height: size.iconMicro },
})

const SIZES = { icon: styles.icon, dense: styles.dense, micro: styles.micro }
