/** Decorative startup board. It measures no work: the connection owns its lifetime. */
export const COLUMNS = 10
export const ROWS = 12
type Cell = readonly [number, number]
export type Block = { x: number; y: number; tone: number }
export type Piece = { cells: readonly Cell[]; x: number; y: number; tone: number }
export type Game = { blocks: Block[]; piece: Piece; bag: number[]; clearing: number[]; phase: "falling" | "locked" | "clearing" | "restart" }

const SHAPES: readonly (readonly Cell[])[] = [
  [[0, 0], [1, 0], [2, 0], [3, 0]],
  [[0, 0], [1, 0], [0, 1], [1, 1]],
  [[1, 0], [0, 1], [1, 1], [2, 1]],
  [[1, 0], [2, 0], [0, 1], [1, 1]],
  [[0, 0], [1, 0], [1, 1], [2, 1]],
  [[0, 0], [0, 1], [1, 1], [2, 1]],
  [[2, 0], [0, 1], [1, 1], [2, 1]],
]

export function fits(blocks: readonly Block[], piece: Piece): boolean {
  return piece.cells.every(([dx, dy]) => {
    const x = piece.x + dx, y = piece.y + dy
    return x >= 0 && x < COLUMNS && y < ROWS && !blocks.some(block => block.x === x && block.y === y)
  })
}

export function pieceBlocks(piece: Piece): Block[] {
  return piece.cells.map(([x, y]) => ({ x: x + piece.x, y: y + piece.y, tone: piece.tone }))
}

function rotate(cells: readonly Cell[]): Cell[] {
  const rotated = cells.map(([x, y]): Cell => [-y, x])
  const left = Math.min(...rotated.map(([x]) => x))
  const top = Math.min(...rotated.map(([, y]) => y))
  return rotated.map(([x, y]) => [x - left, y - top])
}

/** Favor low, hole-free placements; random tie breaking keeps launches different. */
function placement(blocks: Block[], tone: number, random: () => number): Piece {
  let cells = SHAPES[tone]!
  let best: Piece = { cells, tone, x: 3, y: -4 }
  let bestScore = Infinity
  for (let turn = 0; turn < 4; turn++) {
    const width = Math.max(...cells.map(([x]) => x)) + 1
    for (let x = 0; x <= COLUMNS - width; x++) {
      let candidate: Piece = { cells, tone, x, y: -4 }
      while (fits(blocks, { ...candidate, y: candidate.y + 1 })) candidate = { ...candidate, y: candidate.y + 1 }
      if (pieceBlocks(candidate).some(block => block.y < 0)) continue
      const filled = [...blocks, ...pieceBlocks(candidate)]
      const heights = Array.from({ length: COLUMNS }, (_, column) => ROWS - Math.min(ROWS, ...filled.filter(block => block.x === column).map(block => block.y)))
      let holes = 0
      for (let column = 0; column < COLUMNS; column++) {
        for (let row = ROWS - heights[column]!; row < ROWS; row++) {
          if (!filled.some(block => block.x === column && block.y === row)) holes++
        }
      }
      const lines = fullRows(filled).length
      const roughness = heights.slice(1).reduce((sum, height, index) => sum + Math.abs(height - heights[index]!), 0)
      const score = holes * 12 + heights.reduce((sum, height) => sum + height, 0) + roughness * 0.8 - lines * 12 + random() * 1.5
      if (score < bestScore) {
        bestScore = score
        best = { ...candidate, y: -Math.max(...cells.map(([, y]) => y)) - 1 }
      }
    }
    cells = rotate(cells)
  }
  return best
}

function fullRows(blocks: readonly Block[]): number[] {
  return Array.from({ length: ROWS }, (_, y) => y).filter(y => blocks.filter(block => block.y === y).length === COLUMNS)
}

function spawn(blocks: Block[], remaining: number[], random: () => number): Game {
  const bag = [...remaining]
  if (bag.length === 0) {
    bag.push(0, 1, 2, 3, 4, 5, 6)
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1))
      ;[bag[i], bag[j]] = [bag[j]!, bag[i]!]
    }
  }
  return { blocks, bag, piece: placement(blocks, bag.pop()!, random), clearing: [], phase: "falling" }
}

export function createGame(random: () => number = Math.random): Game {
  return spawn([], [], random)
}

export function stepGame(game: Game, random: () => number = Math.random): Game {
  if (game.phase === "restart") return createGame(random)
  if (game.phase === "clearing") {
    const blocks = game.blocks.filter(block => !game.clearing.includes(block.y)).map(block => ({
      ...block, y: block.y + game.clearing.filter(row => row > block.y).length,
    }))
    return spawn(blocks, game.bag, random)
  }
  if (game.phase === "locked") {
    const clearing = fullRows(game.blocks)
    return clearing.length > 0 ? { ...game, clearing, phase: "clearing" } : spawn(game.blocks, game.bag, random)
  }
  const next = { ...game.piece, y: game.piece.y + 1 }
  if (fits(game.blocks, next)) return { ...game, piece: next }
  const landed = pieceBlocks(game.piece)
  if (landed.some(block => block.y < 0)) return { ...game, phase: "restart" }
  return { ...game, blocks: [...game.blocks, ...landed], phase: "locked" }
}
