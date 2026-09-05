import { expect, test } from "bun:test"
import { COLUMNS, ROWS, createGame, fits, pieceBlocks, stepGame, type Game } from "./tetris.ts"

test("randomized games fall one row at a time, lock without overlap, and clear lines", () => {
  for (let seed = 1; seed <= 12; seed++) {
    let value = seed
    const random = (): number => ((value = (Math.imul(value, 1664525) + 1013904223) >>> 0) / 4294967296)
    let game = createGame(random)
    let clears = 0
    for (let tick = 0; tick < 1200; tick++) {
      const next = stepGame(game, random)
      expect(new Set(next.blocks.map(block => `${block.x}:${block.y}`)).size).toBe(next.blocks.length)
      expect(next.blocks.every(block => block.x >= 0 && block.x < COLUMNS && block.y >= 0 && block.y < ROWS)).toBe(true)
      if (game.phase === "falling" && next.phase === "falling") {
        expect(next.piece.y).toBe(game.piece.y + 1)
        expect(fits(game.blocks, next.piece)).toBe(true)
      }
      if (game.phase === "falling" && next.phase === "locked") {
        expect(fits(game.blocks, { ...game.piece, y: game.piece.y + 1 })).toBe(false)
        expect(next.blocks.length).toBe(game.blocks.length + 4)
      }
      if (game.phase === "clearing") clears += game.clearing.length
      game = next
    }
    expect(clears).toBeGreaterThan(0)
  }
})

test("each seven-piece bag contains all tetrominoes", () => {
  let game = createGame()
  const tones: number[] = []
  while (tones.length < 14) {
    if (game.phase === "locked") tones.push(game.piece.tone)
    game = stepGame(game)
  }
  expect(new Set(tones.slice(0, 7)).size).toBe(7)
  expect(new Set(tones.slice(7, 14)).size).toBe(7)
})

test("clearing rows removes only those rows and drops blocks by the gaps below them", () => {
  const initial = createGame()
  const game: Game = { ...initial, phase: "clearing", clearing: [10, 11], blocks: [
    ...Array.from({ length: 20 }, (_, i) => ({ x: i % 10, y: 10 + Math.floor(i / 10), tone: 0 })),
    { x: 3, y: 9, tone: 2 },
  ] }
  expect(stepGame(game).blocks).toEqual([{ x: 3, y: 11, tone: 2 }])
  expect(pieceBlocks(initial.piece)).toHaveLength(4)
})
