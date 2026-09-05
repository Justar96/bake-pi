import { describe, expect, test } from "bun:test"
import { diffPieces } from "./word-diff.ts"

describe("word-level pieces inside a changed line", () => {
  test("marks only the tokens that actually differ", () => {
    const { del, add } = diffPieces(
      '  await freezer.store(base, { temp: "-14C" });',
      '  await freezer.store(base, { temp: "-16C" });',
    )
    expect(del).toEqual([
      { text: '  await freezer.store(base, { temp: ' },
      { text: '"-14C"', change: "del" },
      { text: " });" },
    ])
    expect(add).toEqual([
      { text: '  await freezer.store(base, { temp: ' },
      { text: '"-16C"', change: "add" },
      { text: " });" },
    ])
  })

  test("treats an identical line as one unmarked piece", () => {
    expect(diffPieces("return base.gallons;", "return base.gallons;")).toEqual({
      del: [{ text: "return base.gallons;" }],
      add: [{ text: "return base.gallons;" }],
    })
  })

  test("marks a whole line that has no counterpart", () => {
    expect(diffPieces("old only", "")).toEqual({
      del: [{ text: "old only", change: "del" }],
      add: [],
    })
    expect(diffPieces("", "new only")).toEqual({
      del: [],
      add: [{ text: "new only", change: "add" }],
    })
  })
})
