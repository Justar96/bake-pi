import { describe, expect, test } from "bun:test"
import { ansiTokens, hasAnsi, stripAnsi } from "./ansi.ts"
import { RAMPS } from "./code-theme.ts"

describe("terminal escape codes", () => {
  test("strips colour, cursor and title sequences", () => {
    expect(stripAnsi("[31mfail[0m [2K]0;titleok")).toBe("fail ok")
    expect(hasAnsi("plain")).toBe(false)
    expect(hasAnsi("[1mbold")).toBe(true)
  })

  test("turns SGR runs into tokens on the grey ramp, one list per line", () => {
    const lines = ansiTokens("[1;31m✗ failed[0m\n[32m✓ passed[39m plain\n", "dark")
    expect(lines).toEqual([
      [{ text: "✗ failed", color: RAMPS.dark.keyword, bold: true, italic: false, underline: false }],
      [
        { text: "✓ passed", color: RAMPS.dark.name, bold: false, italic: false, underline: false },
        { text: " plain", color: undefined, bold: false, italic: false, underline: false },
      ],
    ])
  })

  test("skips extended colour parameters without losing the text", () => {
    const [line] = ansiTokens("[38;5;196mred[38;2;1;2;3mtrue", "dark")
    expect(line?.map((token) => token.text).join("")).toBe("redtrue")
  })

  test("keeps a blank line in the middle and drops the trailing newline", () => {
    expect(ansiTokens("a\n\nb\n", "dark").map((line) => line.map((token) => token.text).join(""))).toEqual(["a", "", "b"])
  })
})
