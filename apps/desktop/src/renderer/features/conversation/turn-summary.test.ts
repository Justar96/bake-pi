import { describe, expect, test } from "bun:test"
import type { ContentBlock, Message, ToolCall, ToolResult } from "@bake-pi/contract"
import { completedTimelineRows } from "./timeline-projection.ts"
import { turnSummary } from "./turn-summary.ts"

const call = (rest: Partial<ToolCall> & { id: string; name: string }): ToolCall => ({
  source: "builtin",
  args: {},
  targets: [],
  status: "succeeded",
  ...rest,
})

const callBlock = (index: number, made: ToolCall): ContentBlock => ({ kind: "tool_call", index, call: made })

const lookup = (results: ToolResult[]) => ({ get: (id: string) => results.find((result) => result.toolCallId === id) })

const turn = (messages: Message[], results: ToolResult[] = []) => turnSummary(completedTimelineRows(messages), lookup(results))

const prompt = (id: string, at: number): Message => ({ id, role: "user", status: "complete", createdAt: at, blocks: [{ kind: "text", index: 0, text: "go" }] })

describe("summarizing the turn that just ended", () => {
  test("counts the turn's tools, its tool time, and what it spent", () => {
    const messages: Message[] = [
      prompt("u1", 1),
      {
        id: "a1",
        role: "assistant",
        status: "complete",
        createdAt: 2,
        usage: { inputTokens: 12_300, outputTokens: 1100 },
        blocks: [
          callBlock(0, call({ id: "c1", name: "read", startedAt: 10, endedAt: 60 })),
          callBlock(1, call({ id: "c2", name: "bash", startedAt: 60, endedAt: 1260 })),
          { kind: "text", index: 2, text: "done" },
        ],
      },
    ]

    expect(turn(messages)).toMatchObject({ key: "a1", tools: 2, failed: 0, toolMs: 1250, inputTokens: 12_300, outputTokens: 1100 })
  })

  test("names the files the turn changed, with the same counts their steps drew", () => {
    const edit = call({
      id: "c1",
      name: "edit",
      args: { path: "D:/w/src/Timeline.tsx", edits: [{ oldText: "one\ntwo", newText: "one\ntwo!" }] },
      targets: [{ path: "D:/w/src/Timeline.tsx", insideWorkspace: true, kind: "write" }],
    })
    const write = call({
      id: "c2",
      name: "write",
      args: { path: "D:/w/src/new.ts", content: "a\nb\nc\n" },
      targets: [{ path: "D:/w/src/new.ts", insideWorkspace: true, kind: "write" }],
    })
    const messages: Message[] = [
      prompt("u1", 1),
      { id: "a1", role: "assistant", status: "complete", createdAt: 2, blocks: [callBlock(0, edit), callBlock(1, write)] },
    ]

    expect(turn(messages)?.changes).toEqual([
      { path: "D:/w/src/Timeline.tsx", name: "Timeline.tsx", added: 1, removed: 1 },
      { path: "D:/w/src/new.ts", name: "new.ts", added: 3, removed: 0 },
    ])
  })

  test("sums a file the turn touched twice into one row", () => {
    const once = (id: string): ToolCall => call({
      id,
      name: "edit",
      args: { path: "/w/a.ts", edits: [{ oldText: "x", newText: "y" }] },
      targets: [{ path: "/w/a.ts", insideWorkspace: true, kind: "write" }],
    })
    const messages: Message[] = [
      prompt("u1", 1),
      { id: "a1", role: "assistant", status: "complete", createdAt: 2, blocks: [callBlock(0, once("c1")), callBlock(1, once("c2"))] },
    ]

    expect(turn(messages)?.changes).toEqual([{ path: "/w/a.ts", name: "a.ts", added: 2, removed: 2 }])
  })

  test("prefers the patch Pi returned to the arguments it was given", () => {
    const edit = call({
      id: "c1",
      name: "edit",
      args: { path: "/w/a.ts", edits: [{ oldText: "x", newText: "y" }] },
      targets: [{ path: "/w/a.ts", insideWorkspace: true, kind: "write" }],
    })
    const patch = [
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,3 @@",
      " keep",
      "-gone",
      "+new",
      "+more",
      "",
    ].join("\n")
    const messages: Message[] = [
      prompt("u1", 1),
      { id: "a1", role: "assistant", status: "complete", createdAt: 2, blocks: [callBlock(0, edit)] },
    ]

    expect(turn(messages, [{ toolCallId: "c1", status: "succeeded", output: patch, truncated: false }])?.changes)
      .toEqual([{ path: "/w/a.ts", name: "a.ts", added: 2, removed: 1 }])
  })

  test("a denied or failed write is a decision, not a change", () => {
    const denied = call({
      id: "c1",
      name: "write",
      status: "denied",
      args: { path: "/w/a.ts", content: "x\n" },
      targets: [{ path: "/w/a.ts", insideWorkspace: true, kind: "write" }],
    })
    const broke = call({ id: "c2", name: "bash", status: "failed", args: { command: "false" } })
    const messages: Message[] = [
      prompt("u1", 1),
      { id: "a1", role: "assistant", status: "complete", createdAt: 2, blocks: [callBlock(0, denied), callBlock(1, broke)] },
    ]

    expect(turn(messages)).toMatchObject({ tools: 2, failed: 1, changes: [] })
  })

  test("only the last turn, and only what carries a measurement", () => {
    const messages: Message[] = [
      prompt("u1", 1),
      { id: "a1", role: "assistant", status: "complete", createdAt: 2, blocks: [callBlock(0, call({ id: "old", name: "read" }))] },
      prompt("u2", 3),
      {
        id: "a2",
        role: "assistant",
        status: "complete",
        createdAt: 4,
        blocks: [callBlock(0, call({ id: "c1", name: "bash", args: { command: "mv a b" }, targets: [{ path: "/w/b", insideWorkspace: true, kind: "write" }] }))],
      },
    ]

    // The tool from the previous turn is not counted, and the move reported a
    // written file with no lines behind it rather than `+0 −0`.
    expect(turn(messages)).toMatchObject({
      key: "a2",
      tools: 1,
      toolMs: undefined,
      inputTokens: undefined,
      changes: [{ path: "/w/b", name: "b", added: undefined, removed: undefined }],
    })
  })

  test("a turn that only spoke has nothing to recap", () => {
    const messages: Message[] = [
      prompt("u1", 1),
      { id: "a1", role: "assistant", status: "complete", createdAt: 2, blocks: [{ kind: "text", index: 0, text: "hello" }] },
    ]

    expect(turn(messages)).toBeUndefined()
    expect(turn([])).toBeUndefined()
  })

  test("a turn whose results arrived as their own system message is still one turn", () => {
    const messages: Message[] = [
      prompt("u1", 1),
      { id: "a1", role: "assistant", status: "complete", createdAt: 2, blocks: [callBlock(0, call({ id: "c1", name: "read" }))] },
      {
        id: "s1",
        role: "system",
        status: "complete",
        createdAt: 3,
        blocks: [{ kind: "tool_result", index: 0, result: { toolCallId: "c1", status: "succeeded", output: "a\n", truncated: false } }],
      },
      { id: "a2", role: "assistant", status: "complete", createdAt: 4, blocks: [{ kind: "text", index: 0, text: "read it" }] },
    ]

    expect(turn(messages)).toMatchObject({ key: "a2", tools: 1 })
  })
})
