import { describe, expect, test } from "bun:test"
import type { ToolCall, ToolResult } from "@bake-pi/contract"
import { briefDiff, isChangeActivity, isVerboseActivity, presentReasoning, presentToolCall, presentToolResult, presentToolStep, summarizeActivity, type ListingRow } from "./tool-present.ts"

const call = (name: string, args: unknown, rest: Partial<ToolCall> = {}): ToolCall => ({
  id: "call-1",
  name,
  source: "builtin",
  args,
  targets: [],
  status: "running",
  ...rest,
})

test("shell runs stay verbose; edits and writes are a live preview instead", () => {
  expect(isVerboseActivity("shell")).toBe(true)
  expect(isVerboseActivity("edit")).toBe(false)
  expect(isVerboseActivity("write")).toBe(false)
  expect(isChangeActivity("edit")).toBe(true)
  expect(isChangeActivity("write")).toBe(true)
  expect(isChangeActivity("shell")).toBe(false)
})

describe("presenting reasoning", () => {
  test("uses the first meaningful line as the phase heading", () => {
    expect(presentReasoning("  Found project files  \nNeed to inspect the theme.", false)).toEqual({
      kind: "reasoning",
      label: "Found project files",
      description: "  Found project files  \nNeed to inspect the theme.",
    })
  })

  test("keeps empty and provider-redacted reasoning explicit", () => {
    expect(presentReasoning("  \n", false)).toEqual({ kind: "reasoning", label: "Thinking" })
    expect(presentReasoning("secret", true)).toEqual({ kind: "reasoning", label: "Reasoning (provider-redacted)" })
  })
})

describe("presenting a tool call", () => {
  test("a shell tool is the command it ran, and that is not a listing", () => {
    const presented = presentToolCall(call("bash", { command: "ls src" }))
    expect(presented).toMatchObject({
      kind: "shell",
      label: "Ran ls src",
      command: { filename: "bash", text: "ls src", language: "bash" },
    })
    // The step draws a command and its output as one transcript, and it can
    // only tell them apart if the command never arrives as `code`.
    expect(presented.code).toBeUndefined()
  })

  test("powershell is a shell too", () => {
    const presented = presentToolCall(call("powershell", { command: "Get-ChildItem" }))
    expect(presented.kind).toBe("shell")
    expect(presented.command?.language).toBe("powershell")
  })

  test("an edit is a word-level diff of oldText against newText", () => {
    const presented = presentToolCall(call("edit", {
      path: "D:/hobby/bake-pi/src/churn.ts",
      edits: [{ oldText: 'temp: "-14C"', newText: 'temp: "-16C"' }],
    }))
    expect(presented.kind).toBe("edit")
    expect(presented.label).toBe("Edited")
    expect(presented.target).toBe("churn.ts")
    expect(presented.diffs?.[0]?.rows).toEqual([
      {
        old: null,
        cur: null,
        type: "del",
        text: 'temp: "-14C"',
        pieces: [{ text: "temp: " }, { text: '"-14C"', change: "del" }],
      },
      {
        old: null,
        cur: null,
        type: "add",
        text: 'temp: "-16C"',
        pieces: [{ text: "temp: " }, { text: '"-16C"', change: "add" }],
      },
    ])
  })

  test("a write is the new file contents", () => {
    const presented = presentToolCall(call("write", { path: "src/value.ts", content: "export const value = 1\n" }))
    expect(presented).toMatchObject({
      kind: "write",
      label: "Wrote",
      target: "value.ts",
      code: { filename: "value.ts", text: "export const value = 1\n", language: "ts" },
    })
  })

  /*
   * The split the row's design depends on, asserted as data.
   *
   * The header draws `label` as the verb and `target` as a chip beside it,
   * with `targetPath` only as the chip's tooltip. A regression here has no
   * visual tell in a passing suite — the words are all still on the row — so
   * these check the shape rather than the sentence: the verb carries no file
   * name, the chip carries no directory, and the path is present but not
   * drawn.
   */
  test("a file step separates the verb from the file it acted on", () => {
    expect(presentToolCall(call("read", { path: "D:/repo/src/app.tsx" }))).toEqual({
      kind: "read",
      label: "Read",
      target: "app.tsx",
      targetPath: "D:/repo/src/app.tsx",
    })
  })

  test("a Windows path is split on its own separator", () => {
    const windows = String.raw`C:\repo\src\app.tsx`
    const presented = presentToolCall(call("read", { path: windows }))
    expect(presented.target).toBe("app.tsx")
    expect(presented.targetPath).toBe(windows)
  })

  test("a listing names its directory, and changes the sentence when it has none", () => {
    expect(presentToolCall(call("ls", { path: "src/renderer" }))).toEqual({
      kind: "list",
      label: "Listed",
      target: "renderer",
      targetPath: "src/renderer",
    })
    // No chip to hang off the verb, so the verb says what it listed instead.
    expect(presentToolCall(call("ls", {}))).toEqual({ kind: "list", label: "Listed files" })
  })

  test("a call with no path has a verb and nothing to point at", () => {
    // `code` needs a filename to label the listing with, so a pathless write
    // has no preview either — the alternative was a listing titled "undefined".
    expect(presentToolCall(call("write", { content: "orphan" }))).toEqual({ kind: "write", label: "Wrote" })
    expect(presentToolCall(call("edit", { edits: [] }))).toEqual({ kind: "edit", label: "Edited" })
  })

  test("a command and a pattern are not files, so neither gets a chip", () => {
    const shell = presentToolCall(call("bash", { command: "rm -rf build", path: "build" }))
    expect(shell.target).toBeUndefined()
    expect(shell.targetPath).toBeUndefined()

    const search = presentToolCall(call("grep", { pattern: "color tokens\nignored", path: "src" }))
    expect(search).toEqual({ kind: "search", label: 'Searched "color tokens…"', description: "src" })
  })

  test("a search with no pattern still says which tool looked", () => {
    expect(presentToolCall(call("grep", {}))).toEqual({ kind: "search", label: "Searched with grep" })
  })

  test("a todo extension action reads as plan progress, not a generic extension", () => {
    const presented = presentToolCall(call("todo", { action: "add", text: "Wire the question card" }, { source: "extension" }))
    expect(presented).toEqual({ kind: "todo", label: "Added Wire the question card" })
  })
})

describe("presenting a tool result", () => {
  test("a unified patch becomes a diff, not a transcript", () => {
    const result: ToolResult = {
      toolCallId: "call-1",
      status: "succeeded",
      truncated: false,
      output: `diff --git a/src/value.ts b/src/value.ts
index 1111111..2222222 100644
--- a/src/value.ts
+++ b/src/value.ts
@@ -1,2 +1,2 @@
 const first = 1
-const second = 2
+const second = 22
`,
    }
    const presented = presentToolResult(result, call("edit", { path: "src/value.ts", edits: [] }))
    expect(presented.kind).toBe("edit")
    expect(presented.label).toBe("Changes")
    expect(presented.diffs?.[0]?.filename).toBe("src/value.ts")
    expect(presented.diffs?.[0]?.added).toBe(1)
    expect(presented.diffs?.[0]?.removed).toBe(1)
  })

  test("shell output stays a code listing under the command that produced it", () => {
    const result: ToolResult = {
      toolCallId: "call-1",
      status: "succeeded",
      truncated: false,
      output: "churn.ts\nvalue.ts\n",
    }
    const presented = presentToolResult(result, call("bash", { command: "ls" }))
    expect(presented).toMatchObject({
      kind: "shell",
      label: "Output",
      code: { filename: "bash", text: "churn.ts\nvalue.ts\n", language: "bash" },
    })
    // A transcript, not a command. This result stands alone precisely because
    // its call never arrived, so there is nothing to pair it with, and drawing
    // it under a `$` would say the output was the thing that was typed.
    expect(presented.command).toBeUndefined()
  })

  test("terminal outcomes keep denied and stopped distinct from failure", () => {
    const failed: ToolResult = { toolCallId: "call-1", status: "failed", truncated: false, output: "no such file" }
    expect(presentToolResult(failed, call("bash", { command: "cat x" })).label).toBe("Failed")
    expect(presentToolResult({ ...failed, status: "denied" }, call("bash", { command: "cat x" })).label).toBe("Denied")
    expect(presentToolResult({ ...failed, status: "aborted" }, call("bash", { command: "cat x" })).label).toBe("Stopped")
    const silent: ToolResult = { toolCallId: "call-1", status: "succeeded", truncated: false, output: "" }
    expect(presentToolResult(silent, call("custom", {})).label).toBe("Done")
  })
})

describe("summarizeActivity", () => {
  test("counts the lines of a listing, ignoring the trailing newline", () => {
    expect(summarizeActivity({ kind: "shell", label: "Output", code: { filename: "bash", text: "a\nb\n", language: "bash" } })).toBe("2 lines")
    expect(summarizeActivity({ kind: "shell", label: "Output", code: { filename: "bash", text: "a", language: "bash" } })).toBe("1 line")
  })

  test("totals a diff's additions and removals across files", () => {
    const diff = (filename: string, added: number, removed: number) => ({ filename, added, removed, rows: [] })
    expect(summarizeActivity({ kind: "edit", label: "Changes", diffs: [diff("a.ts", 3, 1)] })).toBe("+3 −1")
    expect(summarizeActivity({ kind: "edit", label: "Changes", diffs: [diff("a.ts", 3, 1), diff("b.ts", 0, 2)] })).toBe("2 files · +3 −3")
  })

  test("has nothing to say about a step with no payload", () => {
    expect(summarizeActivity({ kind: "read", label: "Read a.ts" })).toBeUndefined()
  })

  test("an edit keeps unchanged lines as context and marks only the changed ones", () => {
    const presented = presentToolCall(call("edit", {
      path: "src/a.ts",
      edits: [{ oldText: "a\nb\nc", newText: "a\nB\nc" }],
    }))
    expect(presented.diffs?.[0]?.rows.map((row) => [row.type, row.text])).toEqual([["ctx", "a"], ["del", "b"], ["add", "B"], ["ctx", "c"]])
    expect(presented.diffs?.[0]?.added).toBe(1)
    expect(presented.diffs?.[0]?.removed).toBe(1)
  })

  test("the live preview keeps two lines of context and folds the rest", () => {
    const row = (type: ListingRow["type"], text: string): ListingRow => ({
      old: null, cur: null, type, text, pieces: [{ text }],
    })
    const rows = ["a", "b", "c", "d", "e", "f", "g"].map((text) => row("ctx", text))
    rows[3] = row("del", "D")
    rows.splice(4, 0, row("add", "d2"))
    const brief = briefDiff({ filename: "a.ts", added: 1, removed: 1, rows })
    expect(brief.rows.map((entry) => [entry.type, entry.text])).toEqual([
      ["gap", "1 unchanged line"],
      ["ctx", "b"],
      ["ctx", "c"],
      ["del", "D"],
      ["add", "d2"],
      ["ctx", "e"],
      ["ctx", "f"],
      ["gap", "1 unchanged line"],
    ])
  })

  test("a small edit is already brief, so the preview is the listing", () => {
    const presented = presentToolCall(call("edit", {
      path: "src/a.ts",
      edits: [{ oldText: "a\nb\nc", newText: "a\nB\nc" }],
    }))
    expect(briefDiff(presented.diffs![0]!)).toBe(presented.diffs![0]!)
  })

  describe("a call and its result as one step", () => {
    const done = (output: string, status: ToolResult["status"] = "succeeded"): ToolResult => ({ toolCallId: "call-1", status, truncated: false, output })

    test("a shell step keeps the command and adds the output, sized on the header", () => {
      const step = presentToolStep(call("bash", { command: "ls" }), done("a.ts\nb.ts\n"))
      expect(step.label).toBe("Ran ls")
      expect(step.description).toBe("2 lines")
      expect(step.command?.text).toBe("ls")
      expect(step.output).toEqual({ filename: "bash", text: "a.ts\nb.ts\n", language: "bash" })
    })

    test("an edit prefers the patch Pi returned over the arguments", () => {
      const step = presentToolStep(
        call("edit", { path: "src/value.ts", edits: [{ oldText: "const second = 2", newText: "const second = 22" }] }),
        done("--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1,2 +1,2 @@\n const first = 1\n-const second = 2\n+const second = 22\n"),
      )
      expect(step.diffs?.[0]?.rows.map((row) => row.cur)).toEqual([1, null, 2])
      expect(step.description).toBe("+1 −1")
      expect(step.target).toBe("value.ts")
      expect(step.targetPath).toBe("src/value.ts")
      expect(step.output).toBeUndefined()
    })

    test("a write does not repeat its confirmation, but unsuccessful writes show why", () => {
      const write = call("write", { path: "src/new.ts", content: "export const x = 1\n" })
      expect(presentToolStep(write, done("Successfully wrote 1 line")).output).toBeUndefined()
      expect(presentToolStep(write, done("EACCES: permission denied", "failed")).output?.filename).toBe("error")
      expect(presentToolStep(write, done("Bake Pi denied this tool", "denied")).output?.filename).toBe("error")
      expect(presentToolStep(write, done("Bake Pi cancelled this tool", "aborted")).output?.filename).toBe("error")
    })

    test("a read shows the file under its own name and language", () => {
      const step = presentToolStep(call("read", { path: "D:/repo/src/app.tsx" }), done("export {}\n"))
      expect(step.output).toEqual({ filename: "app.tsx", text: "export {}\n", language: "tsx" })
      // The path is the chip's tooltip now, not a second run of text on the row.
      expect(step.description).toBe("1 line")
      expect(step.target).toBe("app.tsx")
      expect(step.targetPath).toBe("D:/repo/src/app.tsx")
    })

    test("without a result the step is the call alone", () => {
      expect(presentToolStep(call("bash", { command: "ls" }), undefined).output).toBeUndefined()
    })

    test("a todo result summarizes its current state without rendering the raw transcript", () => {
      const todo = call("todo", { action: "toggle", id: 1 }, { source: "extension" })
      const step = presentToolStep(todo, {
        toolCallId: "call-1",
        status: "succeeded",
        output: "Todo #1 completed",
        truncated: false,
        todo: { items: [{ id: "1", text: "Inspect", status: "completed" }, { id: "2", text: "Verify", status: "pending" }] },
      })
      expect(step).toEqual({ kind: "todo", label: "Updated the plan", description: "1 of 2 complete" })
    })
  })

  test("two hunks are separated by a fold that counts the lines between them", () => {
    const result: ToolResult = {
      toolCallId: "call-1",
      status: "succeeded",
      truncated: false,
      output: "--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n@@ -10,2 +10,2 @@\n j\n-k\n+K\n",
    }
    const rows = presentToolResult(result, undefined).diffs?.[0]?.rows ?? []
    expect(rows.map((row) => row.type)).toEqual(["ctx", "del", "add", "gap", "ctx", "del", "add"])
    expect(rows[3]?.text).toBe("7 unchanged lines")
  })
})
