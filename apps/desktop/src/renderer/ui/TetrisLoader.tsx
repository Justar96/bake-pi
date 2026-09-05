import { useEffect, useState } from "react"
import * as stylex from "@stylexjs/stylex"
import { colors, radius } from "../theme/tokens.stylex.ts"
import { createGame, pieceBlocks, stepGame } from "./tetris.ts"

export function TetrisLoader(): React.JSX.Element {
  const [game, setGame] = useState(createGame)
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)")
    let timer: ReturnType<typeof setTimeout> | undefined
    let current = createGame()
    const tick = (): void => {
      current = stepGame(current)
      setGame(current)
      timer = setTimeout(tick, current.phase === "falling" ? 65 : current.phase === "restart" ? 300 : 180)
    }
    const synchronize = (): void => {
      clearTimeout(timer)
      // Reduced motion shows a settled board, with the text carrying status.
      if (reduced.matches) {
        let still = createGame(() => 0.5)
        for (let i = 0; i < 65; i++) still = stepGame(still, () => 0.5)
        setGame({ ...still, phase: "locked" })
      } else if (!document.hidden) {
        setGame(current)
        timer = setTimeout(tick, 65)
      }
    }
    synchronize()
    reduced.addEventListener("change", synchronize)
    document.addEventListener("visibilitychange", synchronize)
    return () => {
      clearTimeout(timer)
      reduced.removeEventListener("change", synchronize)
      document.removeEventListener("visibilitychange", synchronize)
    }
  }, [])

  return (
    <svg aria-hidden="true" viewBox="0 0 160 192" {...stylex.props(styles.board, game.phase === "restart" && styles.clearing)}>
      {game.blocks.map(block => (
        <rect key={`${block.x}:${block.y}`} x={block.x * 16 + 1} y={block.y * 16 + 1} width="14" height="14" rx="2"
          {...stylex.props(styles.block, tones[block.tone], game.clearing.includes(block.y) && styles.clearing)} />
      ))}
      {game.phase === "falling" ? <g transform={`translate(${game.piece.x * 16} ${game.piece.y * 16})`}>
        {pieceBlocks({ ...game.piece, x: 0, y: 0 }).map(block => (
          <rect key={`${block.x}:${block.y}`} x={block.x * 16 + 1} y={block.y * 16 + 1} width="14" height="14" rx="2" {...stylex.props(styles.block, tones[block.tone])} />
        ))}
      </g> : null}
    </svg>
  )
}

const styles = stylex.create({
  board: { display: "block", width: "128px", height: "154px", maxWidth: "100%", overflow: "hidden", backgroundColor: colors.sunken, borderRadius: radius.md },
  block: { opacity: 1, transitionProperty: "opacity", transitionDuration: "180ms", transitionTimingFunction: "linear" },
  clearing: { opacity: 0.15 },
  cyan: { fill: colors.running },
  yellow: { fill: colors.warning },
  purple: { fill: colors.reasoning },
  green: { fill: colors.success },
  red: { fill: colors.danger },
  blue: { fill: colors.accent },
  orange: { fill: colors.diffRemoved },
})
const tones = [styles.cyan, styles.yellow, styles.purple, styles.green, styles.red, styles.blue, styles.orange]
