import { describe, expect, test } from "bun:test"
import {
  HighlightCache,
  MAX_HIGHLIGHT_CHARACTERS,
  MAX_HIGHLIGHT_LINES,
  shouldHighlight,
} from "./highlight.ts"

describe("highlight resource limits", () => {
  test("large source and very tall source fall back to plain text", () => {
    expect(shouldHighlight("a".repeat(MAX_HIGHLIGHT_CHARACTERS))).toBe(true)
    expect(shouldHighlight("a".repeat(MAX_HIGHLIGHT_CHARACTERS + 1))).toBe(false)
    expect(shouldHighlight(Array.from({ length: MAX_HIGHLIGHT_LINES }, () => "a").join("\n"))).toBe(true)
    expect(shouldHighlight(Array.from({ length: MAX_HIGHLIGHT_LINES + 1 }, () => "a").join("\n"))).toBe(false)
  })

  test("the least recently used entry is evicted first", () => {
    const cache = new HighlightCache<string>(2, 100)
    cache.set("a", "A", 10)
    cache.set("b", "B", 10)
    expect(cache.get("a")).toBe("A")
    cache.set("c", "C", 10)

    expect(cache.get("a")).toBe("A")
    expect(cache.get("b")).toBeUndefined()
    expect(cache.get("c")).toBe("C")
  })

  test("source weight bounds the cache independently of entry count", () => {
    const cache = new HighlightCache<string>(10, 10)
    cache.set("a", "A", 6)
    cache.set("b", "B", 6)
    expect(cache.get("a")).toBeUndefined()
    expect(cache.get("b")).toBe("B")

    cache.set("oversize", "never retained", 11)
    expect(cache.get("oversize")).toBeUndefined()
    expect(cache.get("b")).toBe("B")
  })
})
