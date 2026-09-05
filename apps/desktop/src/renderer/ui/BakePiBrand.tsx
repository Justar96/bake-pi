import { useId, useState } from "react"
import * as stylex from "@stylexjs/stylex"
import { colors, space, typography } from "../theme/tokens.stylex.ts"

const PIECES = [
  [[0, 0], [1, 0], [2, 0], [3, 0]],
  [[0, 0], [1, 0], [0, 1], [1, 1]],
  [[1, 0], [0, 1], [1, 1], [2, 1]],
  [[1, 0], [2, 0], [0, 1], [1, 1]],
  [[0, 0], [1, 0], [1, 1], [2, 1]],
  [[0, 0], [0, 1], [1, 1], [2, 1]],
  [[2, 0], [0, 1], [1, 1], [2, 1]],
] as const

/**
 * The SVG text and its clip share the same metrics, so blocks never spill out
 * of the letters. Real text still owns the heading's size and accessible name.
 * Only hover mounts the pieces; StyleX drives their fall without a render loop.
 */
export const BakePiBrand = (): React.JSX.Element => {
  const clip = useId()
  const [hovered, setHovered] = useState(false)
  return (
    <h1
      onPointerEnter={(event) => setHovered(event.pointerType !== "touch" && window.matchMedia("(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)").matches)}
      onPointerLeave={() => setHovered(false)}
      onPointerCancel={() => setHovered(false)}
      {...stylex.props(styles.brand)}
    >
      <span {...stylex.props(styles.label)}>bakepi</span>
      <svg aria-hidden="true" focusable="false" {...stylex.props(styles.art)}>
        <defs>
          <clipPath id={clip}>
            <text x="0" y="50%" dominantBaseline="central">bakepi</text>
          </clipPath>
        </defs>
        <text x="0" y="50%" dominantBaseline="central" {...stylex.props(styles.text, hovered && styles.hoveredText)}>bakepi</text>
        {hovered ? <g clipPath={`url(#${clip})`} {...stylex.props(styles.blocks)}>
          {Array.from({ length: 14 }, (_, index) => (
            <svg key={index} x={`${(index % 7) * 14}%`} {...stylex.props(styles.lane)}>
              <g {...stylex.props(styles.fall, styles.phase(`${-index * 110}ms`), tones[index % tones.length])}>
                {PIECES[index % PIECES.length]!.map(([x, y]) => (
                  <rect key={`${x}:${y}`} x={x * 6} y={y * 6} width="5" height="5" rx="0.5" />
                ))}
              </g>
            </svg>
          ))}
        </g> : null}
      </svg>
    </h1>
  )
}

// A longer linear fall makes the individual tetrominoes legible. This is a
// decorative hover scene, not a transition delaying a workspace action.
const fall = stylex.keyframes({
  "0%": { transform: "translateY(-24px)" },
  "100%": { transform: "translateY(72px)" },
})

const styles = stylex.create({
  brand: { position: "relative", display: "inline-block", marginBlockStart: 0, marginBlockEnd: space.xs, marginInline: 0, color: colors.text, fontFamily: typography.display, fontSize: "56px", fontWeight: 700, lineHeight: "60px" },
  label: { display: "block", opacity: 0 },
  art: { position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "hidden", pointerEvents: "none" },
  text: { fill: colors.text },
  hoveredText: { fill: { default: colors.textFaint, "@media (prefers-reduced-motion: reduce)": colors.text } },
  blocks: { display: { default: "block", "@media (prefers-reduced-motion: reduce)": "none" } },
  lane: { overflow: "visible" },
  fall: { animationName: { default: fall, "@media (prefers-reduced-motion: reduce)": "none" }, animationDuration: "1600ms", animationIterationCount: "infinite", animationTimingFunction: "linear" },
  phase: (delay: string) => ({ animationDelay: delay }),
  cyan: { fill: colors.running },
  yellow: { fill: colors.warning },
  purple: { fill: colors.reasoning },
  green: { fill: colors.success },
  red: { fill: colors.danger },
})
const tones = [styles.cyan, styles.yellow, styles.purple, styles.green, styles.red]
