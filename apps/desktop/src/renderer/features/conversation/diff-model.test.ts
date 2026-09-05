import { describe, expect, test } from "bun:test"
import { parseUnifiedDiff } from "./diff-model.ts"

const PATCH = `diff --git a/src/value.ts b/src/value.ts
index 1111111..2222222 100644
--- a/src/value.ts
+++ b/src/value.ts
@@ -1,4 +1,5 @@ export const value
 const first = 1
-const second = 2
-const third = 3
+const second = 22
+const third = 33
+const fourth = 4
 const last = 5
`

describe("a unified patch becomes rows", () => {
  test("it reports the file, its change type, and its totals", () => {
    const [file] = parseUnifiedDiff(PATCH)
    expect(file?.name).toBe("src/value.ts")
    expect(file?.change).toBe("change")
    expect(file?.added).toBe(3)
    expect(file?.removed).toBe(2)
  })

  test("it numbers both sides the way a reviewer reads them", () => {
    const [file] = parseUnifiedDiff(PATCH)
    const rows = file?.hunks[0]?.rows ?? []
    expect(rows.map((row) => [row.kind, row.oldLine, row.newLine, row.text])).toEqual([
      ["context", 1, 1, "const first = 1"],
      ["removed", 2, undefined, "const second = 2"],
      ["removed", 3, undefined, "const third = 3"],
      ["added", undefined, 2, "const second = 22"],
      ["added", undefined, 3, "const third = 33"],
      ["added", undefined, 4, "const fourth = 4"],
      ["context", 4, 5, "const last = 5"],
    ])
  })

  test("it carries the hunk header and its trailing context", () => {
    const [file] = parseUnifiedDiff(PATCH)
    expect(file?.hunks[0]?.header).toContain("@@ -1,4 +1,5 @@")
    expect(file?.hunks[0]?.context).toBe("export const value")
  })

  test("every row indexes the line array its text came from", () => {
    const [file] = parseUnifiedDiff(PATCH)
    for (const row of file?.hunks[0]?.rows ?? []) {
      const source = row.kind === "removed" ? file?.deletionLines : file?.additionLines
      expect(source?.[row.sourceIndex]).toBe(row.text)
    }
  })

  /**
   * The reason this matters is that it is the common case: tool output is
   * usually a shell transcript or a file listing, and a renderer that guessed
   * "diff" from a leading `-` would mangle it.
   */
  test("output that is not a patch produces no files rather than a wrong one", () => {
    expect(parseUnifiedDiff("Listing files\n- one\n- two\n+ three\n")).toEqual([])
    expect(parseUnifiedDiff("")).toEqual([])
    expect(parseUnifiedDiff("error: command failed with status 1")).toEqual([])
  })
})
