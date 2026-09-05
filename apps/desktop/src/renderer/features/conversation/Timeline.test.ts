import { describe, expect, test } from "bun:test"
import type { ContentBlock, Message } from "@bake-pi/contract"
import { activeTimelineRows, completedTimelineRows, heldChangeKey, streamingModelSwitch } from "./timeline-projection.ts"

const textBlock = (index: number): ContentBlock => ({ kind: "text", index, text: `block ${String(index)}` })

describe("completed timeline virtualization", () => {
  test("projects one virtual row per completed block", () => {
    const messages: Message[] = [
      { id: "m1", role: "assistant", status: "complete", blocks: [textBlock(0), textBlock(1)], createdAt: 1 },
      { id: "m2", role: "assistant", status: "streaming", blocks: [textBlock(0)], createdAt: 2 },
    ]

    expect(completedTimelineRows(messages).map(({ key, first, last }) => ({ key, first, last }))).toEqual([
      { key: "m1:0", first: true, last: false },
      { key: "m1:1", first: false, last: true },
    ])
  })

  test("keeps a ten-thousand-block turn as ten-thousand virtual items", () => {
    const message: Message = {
      id: "large",
      role: "assistant",
      status: "complete",
      blocks: Array.from({ length: 10_000 }, (_unused, index) => textBlock(index)),
      createdAt: 1,
    }

    const rows = completedTimelineRows([message])
    expect(rows).toHaveLength(10_000)
    expect(rows[0]).toMatchObject({ key: "large:0", first: true, last: false })
    expect(rows.at(-1)).toMatchObject({ key: "large:9999", first: false, last: true })
  })
  test("marks a run of reasoning and tools as one thinking-step list, including a tool-result message", () => {
    const messages: Message[] = [
      {
        id: "a",
        role: "assistant",
        status: "complete",
        createdAt: 1,
        blocks: [
          { kind: "text", index: 0, text: "I'll look" },
          { kind: "reasoning", index: 1, text: "need the file", redacted: false },
          { kind: "tool_call", index: 2, call: { id: "c1", name: "bash", source: "builtin", args: { command: "ls" }, targets: [], status: "succeeded" } },
        ],
      },
      {
        id: "r",
        role: "system",
        status: "complete",
        createdAt: 2,
        blocks: [{ kind: "tool_result", index: 0, result: { toolCallId: "c1", status: "succeeded", output: "a.ts\n", truncated: false } }],
      },
      { id: "b", role: "assistant", status: "complete", createdAt: 3, blocks: [textBlock(0)] },
    ]

    // The result for c1 is drawn inside c1's step, so its own row is gone and
    // the run ends on the call. The thought is the phase root and the shell
    // call is its one nested child.
    const rows = completedTimelineRows(messages)
    expect(rows.map(({ key, activity, activityEnd }) => ({ key, activity, activityEnd }))).toEqual([
      { key: "a:0", activity: false, activityEnd: false },
      { key: "a:1", activity: true, activityEnd: false },
      { key: "a:2", activity: true, activityEnd: true },
      { key: "b:0", activity: false, activityEnd: false },
    ])
    expect(rows.map(({ key, activityNested, activityGroupStart, activityGroupEnd }) => ({ key, activityNested, activityGroupStart, activityGroupEnd }))).toEqual([
      { key: "a:0", activityNested: false, activityGroupStart: false, activityGroupEnd: false },
      { key: "a:1", activityNested: false, activityGroupStart: true, activityGroupEnd: false },
      { key: "a:2", activityNested: true, activityGroupStart: false, activityGroupEnd: true },
      { key: "b:0", activityNested: false, activityGroupStart: false, activityGroupEnd: false },
    ])
  })

  test("starts a new root when the turn reasons again", () => {
    const message: Message = {
      id: "a",
      role: "assistant",
      status: "complete",
      createdAt: 1,
      blocks: [
        { kind: "reasoning", index: 0, text: "Found project files", redacted: false },
        { kind: "tool_call", index: 1, call: { id: "c1", name: "read", source: "builtin", args: {}, targets: [], status: "succeeded" } },
        { kind: "reasoning", index: 2, text: "Editing tokens", redacted: false },
        { kind: "tool_call", index: 3, call: { id: "c2", name: "edit", source: "builtin", args: {}, targets: [], status: "succeeded" } },
      ],
    }

    expect(completedTimelineRows([message]).map(({ key, activityNested, activityGroupStart, activityGroupEnd }) => ({ key, activityNested, activityGroupStart, activityGroupEnd }))).toEqual([
      { key: "a:0", activityNested: false, activityGroupStart: true, activityGroupEnd: false },
      { key: "a:1", activityNested: true, activityGroupStart: false, activityGroupEnd: true },
      { key: "a:2", activityNested: false, activityGroupStart: true, activityGroupEnd: false },
      { key: "a:3", activityNested: true, activityGroupStart: false, activityGroupEnd: true },
    ])
  })

  test("keeps a result whose call is not on the timeline", () => {
    const messages: Message[] = [
      {
        id: "r",
        role: "system",
        status: "complete",
        createdAt: 2,
        blocks: [{ kind: "tool_result", index: 0, result: { toolCallId: "orphan", status: "succeeded", output: "a.ts", truncated: false } }],
      },
    ]
    expect(completedTimelineRows(messages).map(({ key }) => key)).toEqual(["r:0"])
  })

  test("drops a completed reasoning block that has no text, and keeps a redacted one", () => {
    const messages: Message[] = [
      {
        id: "a",
        role: "assistant",
        status: "complete",
        createdAt: 1,
        blocks: [
          { kind: "text", index: 0, text: "Hello" },
          { kind: "reasoning", index: 1, text: "", redacted: false },
        ],
      },
      { id: "b", role: "assistant", status: "complete", createdAt: 2, blocks: [{ kind: "reasoning", index: 0, text: "  \n", redacted: false }] },
      { id: "c", role: "assistant", status: "complete", createdAt: 3, blocks: [{ kind: "reasoning", index: 0, text: "", redacted: true }] },
    ]

    expect(completedTimelineRows(messages).map(({ key, last }) => ({ key, last }))).toEqual([
      { key: "a:0", last: true },
      { key: "c:0", last: true },
    ])
  })

  /*
   * An attachment is a row of its own, and not part of a step list.
   *
   * `isActivity` decides what the connector runs through, and an image block
   * falls through its list to the default. Were it ever to count as activity,
   * a person's own attachment would be drawn as an agent action inside the
   * thinking-step rail rather than as the thing they sent.
   */
  test("an attached image is its own row, outside any thinking-step run", () => {
    const messages: Message[] = [
      {
        id: "u",
        role: "user",
        status: "complete",
        createdAt: 1,
        blocks: [
          { kind: "text", index: 0, text: "what is in this" },
          { kind: "image", index: 1, url: "bakepi://image/s1/0/1", mediaType: "image/png" },
        ],
      },
    ]

    const rows = completedTimelineRows(messages)
    expect(rows.map((row) => row.key)).toEqual(["u:0", "u:1"])
    expect(rows[1]).toMatchObject({ activity: false, activityNested: false })
  })

  test("an image whose bytes could not be addressed still occupies a row", () => {
    // The renderer names the image instead of drawing a broken one, which it
    // can only do if the block is still projected. An empty `url` is the host
    // saying it has no address for these bytes, not that there is no block.
    const rows = completedTimelineRows([{
      id: "u",
      role: "user",
      status: "complete",
      createdAt: 1,
      blocks: [{ kind: "image", index: 0, url: "", mediaType: "image/heic", altText: "a photo" }],
    }])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.block).toMatchObject({ kind: "image", url: "" })
  })
})

/**
 * The streaming message is projected by the same rules as the completed rows,
 * because every difference between the two shows up as the turn ending —
 * something moving, doubling or disappearing at the moment the last token
 * lands, which is the moment a person is looking hardest.
 */
describe("the streaming message's rows", () => {
  const streaming = (blocks: ContentBlock[], status: Message["status"] = "streaming"): Message =>
    ({ id: "live", role: "assistant", status, blocks, createdAt: 1 })
  const none = (): boolean => false

  test("marks only the block being produced as live", () => {
    const rows = activeTimelineRows(streaming([
      { kind: "reasoning", index: 0, text: "first thought", redacted: false },
      { kind: "tool_call", index: 1, call: { id: "c1", name: "read", source: "builtin", args: {}, targets: [], status: "succeeded" } },
      { kind: "reasoning", index: 2, text: "second thought", redacted: false },
    ]), none)

    expect(rows.map(({ key, live }) => ({ key, live }))).toEqual([
      { key: "live:0", live: false },
      { key: "live:1", live: false },
      { key: "live:2", live: true },
    ])
  })

  /**
   * A turn is only live while it streams. The same message arrives complete
   * one render later, and a tail still claiming to be live would hold its step
   * open and keep pulsing after the turn was over.
   */
  test("marks nothing live once the message is no longer streaming", () => {
    const rows = activeTimelineRows(streaming([{ kind: "reasoning", index: 0, text: "done", redacted: false }], "complete"), none)
    expect(rows.map(({ live }) => live)).toEqual([false])
  })

  /**
   * Providers open a thinking part before they have anything to put in it, and
   * close a turn with one that carries a signature and no text. The first is
   * the "Reasoning…" being watched; the second is a step that would delete
   * itself when the turn ended.
   */
  test("keeps an empty reasoning block only while it is the tail", () => {
    expect(activeTimelineRows(streaming([{ kind: "reasoning", index: 0, text: "", redacted: false }]), none).map(({ key }) => key)).toEqual(["live:0"])
    expect(activeTimelineRows(streaming([
      { kind: "reasoning", index: 0, text: "", redacted: false },
      { kind: "text", index: 1, text: "answer" },
    ]), none).map(({ key }) => key)).toEqual(["live:1"])
  })

  test("leaves a result to the step of the call it belongs to", () => {
    const blocks: ContentBlock[] = [
      { kind: "tool_call", index: 0, call: { id: "c1", name: "read", source: "builtin", args: {}, targets: [], status: "succeeded" } },
      { kind: "tool_result", index: 1, result: { toolCallId: "c1", status: "succeeded", output: "ok", truncated: false } },
    ]
    expect(activeTimelineRows(streaming(blocks), (id) => id === "c1").map(({ key }) => key)).toEqual(["live:0"])
    // A result whose call never arrived still stands on its own, the same as
    // it does in history.
    expect(activeTimelineRows(streaming(blocks), none).map(({ key }) => key)).toEqual(["live:0", "live:1"])
  })

  /**
   * The run flags are what the connector is drawn from, and they have to be the
   * same flags the completed path produces from the same blocks — otherwise the
   * line down the icon column changes shape when the turn ends.
   */
  test("marks the activity run the way the completed rows do", () => {
    const blocks: ContentBlock[] = [
      { kind: "text", index: 0, text: "I'll look" },
      { kind: "reasoning", index: 1, text: "need the file", redacted: false },
      { kind: "tool_call", index: 2, call: { id: "c1", name: "bash", source: "builtin", args: { command: "ls" }, targets: [], status: "running" } },
    ]
    const shape = ({ key, activity, activityEnd, activityNested, activityGroupStart, activityGroupEnd }: {
      key: string
      activity: boolean
      activityEnd: boolean
      activityNested: boolean
      activityGroupStart: boolean
      activityGroupEnd: boolean
    }) => ({ key, activity, activityEnd, activityNested, activityGroupStart, activityGroupEnd })

    expect(activeTimelineRows(streaming(blocks), none).map(shape)).toEqual([
      { key: "live:0", activity: false, activityEnd: false, activityNested: false, activityGroupStart: false, activityGroupEnd: false },
      { key: "live:1", activity: true, activityEnd: false, activityNested: false, activityGroupStart: true, activityGroupEnd: false },
      { key: "live:2", activity: true, activityEnd: true, activityNested: true, activityGroupStart: false, activityGroupEnd: true },
    ])
    expect(completedTimelineRows([{ ...streaming(blocks, "complete"), id: "live" }]).map(shape)).toEqual(
      activeTimelineRows(streaming(blocks, "complete"), none).map(shape),
    )
  })
})

describe("where a conversation changed model", () => {
  const turn = (id: string, modelId: string | undefined, createdAt: number): Message => ({
    id, role: "assistant", status: "complete", blocks: [textBlock(0), textBlock(1)], createdAt,
    ...(modelId === undefined ? {} : { modelId }),
  })

  test("marks the boundary and only the boundary", () => {
    const rows = completedTimelineRows([
      turn("m1", "claude-opus-5", 1),
      turn("m2", "claude-opus-5", 2),
      turn("m3", "gpt-5", 3),
      turn("m4", "gpt-5", 4),
    ])
    // The first turn has nothing to differ from, the repeats say nothing, and
    // the one turn that changed carries the mark. A conversation held on one
    // model therefore carries none at all.
    expect(rows.filter((row) => row.modelSwitch !== undefined).map((row) => [row.key, row.modelSwitch]))
      .toEqual([["m3:0", "gpt-5"]])
  })

  test("puts it on the row that opens the turn, never a continuation", () => {
    const rows = completedTimelineRows([turn("m1", "claude-opus-5", 1), turn("m2", "gpt-5", 2)])
    expect(rows.find((row) => row.key === "m2:0")?.modelSwitch).toBe("gpt-5")
    expect(rows.find((row) => row.key === "m2:1")?.modelSwitch).toBeUndefined()
  })

  test("is not moved by the user messages between the turns", () => {
    // A user message carries no model. Letting one clear the comparison would
    // mark every assistant turn in an ordinary conversation.
    const rows = completedTimelineRows([
      turn("a1", "claude-opus-5", 1),
      { id: "u1", role: "user", status: "complete", blocks: [textBlock(0)], createdAt: 2 },
      turn("a2", "claude-opus-5", 3),
    ])
    expect(rows.every((row) => row.modelSwitch === undefined)).toBe(true)
  })

  test("says nothing about turns whose model the host never reported", () => {
    const rows = completedTimelineRows([turn("m1", undefined, 1), turn("m2", undefined, 2)])
    expect(rows.every((row) => row.modelSwitch === undefined)).toBe(true)
  })

  test("redraws a row whose mark changed rather than reusing it", () => {
    // The reuse pass exists to keep a held selection alive across an append.
    // A row that gained or lost the boundary has to be replaced anyway, or
    // the mark would be a frame behind the transcript.
    // Same message object both times, which is what the reuse pass compares.
    const held = turn("m1", "claude-opus-5", 1)
    const first = completedTimelineRows([held])
    const second = completedTimelineRows([held, turn("m2", "gpt-5", 2)], first)
    expect(second[0]).toBe(first[0])
    expect(second.find((row) => row.key === "m2:0")?.modelSwitch).toBe("gpt-5")
  })

  test("gives a streaming turn the same mark from the selection it is running on", () => {
    // A streaming message has no model of its own yet. Reading the selection
    // is what makes the mark appear as the turn opens rather than jumping in
    // when the last token lands.
    const settled = [turn("m1", "claude-opus-5", 1)]
    expect(streamingModelSwitch(settled, "gpt-5")).toBe("gpt-5")
    expect(streamingModelSwitch(settled, "claude-opus-5")).toBeUndefined()
    expect(streamingModelSwitch([], "gpt-5")).toBeUndefined()
  })
})

const isChange = (name: string): boolean => name === "edit" || name === "write"

describe("held file-change preview", () => {
  const streaming = (blocks: ContentBlock[]): Message =>
    ({ id: "live", role: "assistant", status: "streaming", blocks, createdAt: 1 })
  const call = (index: number, id: string, name: string): ContentBlock => ({
    kind: "tool_call",
    index,
    call: { id, name, source: "builtin", args: {}, targets: [], status: "succeeded" },
  })

  test("holds the last edit even when prose follows it", () => {
    const rows = activeTimelineRows(streaming([
      { kind: "reasoning", index: 0, text: "changing the token", redacted: false },
      call(1, "c1", "edit"),
      { kind: "text", index: 2, text: "Updated." },
    ]), () => true)
    expect(heldChangeKey(rows, isChange)).toBe("live:1")
  })

  test("holds a write the same way", () => {
    const rows = activeTimelineRows(streaming([call(0, "c1", "write")]), () => true)
    expect(heldChangeKey(rows, isChange)).toBe("live:0")
  })

  test("releases the preview once the next action starts", () => {
    const afterTool = activeTimelineRows(streaming([
      call(0, "c1", "edit"),
      call(1, "c2", "bash"),
    ]), () => true)
    const afterThought = activeTimelineRows(streaming([
      call(0, "c1", "edit"),
      { kind: "reasoning", index: 1, text: "next", redacted: false },
    ]), () => true)
    expect(heldChangeKey(afterTool, isChange)).toBeUndefined()
    expect(heldChangeKey(afterThought, isChange)).toBeUndefined()
  })
})
