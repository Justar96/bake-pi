import { describe, expect, test } from "bun:test"
import { lineDiff } from "./line-diff.ts"

describe("line diff for text edits", () => {
  test("keeps unchanged lines as context around the one that changed", () => {
    expect(lineDiff(["a", "b", "c"], ["a", "B", "c"])).toEqual([
      { type: "ctx", text: "a" },
      { type: "del", text: "b" },
      { type: "add", text: "B" },
      { type: "ctx", text: "c" },
    ])
  })

  test("reports an insertion without deleting anything", () => {
    expect(lineDiff(["a", "c"], ["a", "b", "c"])).toEqual([
      { type: "ctx", text: "a" },
      { type: "add", text: "b" },
      { type: "ctx", text: "c" },
    ])
  })

  test("orders a replacement old-then-new, like a patch", () => {
    expect(lineDiff(["x", "y"], ["p", "q"])).toEqual([
      { type: "del", text: "x" },
      { type: "del", text: "y" },
      { type: "add", text: "p" },
      { type: "add", text: "q" },
    ])
  })

  test("finds context in the middle, not only at the ends", () => {
    expect(lineDiff(["1", "keep", "2"], ["one", "keep", "two"])).toEqual([
      { type: "del", text: "1" },
      { type: "add", text: "one" },
      { type: "ctx", text: "keep" },
      { type: "del", text: "2" },
      { type: "add", text: "two" },
    ])
  })

  test("falls back to a whole-block replacement past the cap", () => {
    const before = Array.from({ length: 400 }, (_unused, index) => `old ${String(index)}`)
    const after = Array.from({ length: 400 }, (_unused, index) => `new ${String(index)}`)
    const rows = lineDiff(before, after)
    expect(rows.filter((row) => row.type === "del")).toHaveLength(400)
    expect(rows.filter((row) => row.type === "add")).toHaveLength(400)
  })
})
