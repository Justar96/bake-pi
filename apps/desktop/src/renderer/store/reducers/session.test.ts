import { describe, expect, test } from "bun:test"
import { SESSION_SCOPED_EVENTS, type SessionSnapshot, type ToolCall } from "@bake-pi/contract"
import { PROJECTION, initialState, reduce, type SessionState } from "./session.ts"

/**
 * What the renderer does with a session event, asserted rather than assumed.
 *
 * `stream.test.ts` covers the fence and the deltas. This covers the events that
 * were reaching the reducer's `default` and being discarded — the tool
 * lifecycle above all, which is the only path by which a tool card enters a
 * live timeline, and which was silently dropped until it was not.
 */

const SESSION = "s1"

const snapshot = (): SessionSnapshot => ({
  sequence: 1,
  summary: { id: SESSION, workspaceId: "w1", title: "test", createdAt: 0, updatedAt: 0, messageCount: 1, path: "/tmp/w1" },
  status: "streaming",
  messages: [
    {
      id: "m0",
      role: "assistant",
      status: "streaming",
      blocks: [{ index: 0, kind: "text", text: "reading the file" }],
      createdAt: 0,
    },
  ],
  queue: [],
  approvals: [],
  model: { modelId: "test", providerId: "test-provider", thinkingLevel: "off", availableThinkingLevels: ["off"] },
  usage: { turnCount: 0, total: { inputTokens: 0, outputTokens: 0 } },
  afterGap: false,
})

const call = (overrides: Partial<ToolCall> = {}): ToolCall => ({
  id: "call-1",
  name: "read",
  source: "builtin",
  args: { path: "/tmp/w1/src/value.ts" },
  targets: [{ path: "/tmp/w1/src/value.ts", insideWorkspace: true, kind: "read" }],
  status: "running",
  startedAt: 10,
  ...overrides,
})

/** Every tool call the projection is holding, in the order the blocks are in. */
const calls = (state: SessionState): ToolCall[] =>
  state.snapshot.messages.flatMap((message) => message.blocks.flatMap((block) => (block.kind === "tool_call" ? [block.call] : [])))

describe("the tool lifecycle reaches the timeline", () => {
  test("a started call becomes a block on the message that made it", () => {
    const state = reduce(initialState(snapshot()), "tool_call_started", { messageId: "m0", call: call() })

    expect(calls(state)).toEqual([call()])
    // After the text block it arrived behind, because the host sends no index
    // and the call was made after the model said what it was about to do.
    expect(state.snapshot.messages[0]!.blocks.map((block) => block.index)).toEqual([0, 1])
  })

  test("a call for a message the projection does not hold is dropped, not synthesized", () => {
    const state = initialState(snapshot())
    expect(reduce(state, "tool_call_started", { messageId: "m99", call: call() })).toBe(state)
  })

  test("an update replaces the call, output so far included, without moving it", () => {
    let state = reduce(initialState(snapshot()), "tool_call_started", { messageId: "m0", call: call() })
    state = reduce(state, "block_finished", { messageId: "m0", block: { index: 0, kind: "text", text: "reading the file now" } })
    state = reduce(state, "tool_call_updated", { call: call({ partialOutput: "export const" }) })

    expect(calls(state)).toEqual([call({ partialOutput: "export const" })])
    expect(state.snapshot.messages[0]!.blocks[1]!.index).toBe(1)
  })

  test("a finished call keeps its description and takes the result's status", () => {
    let state = reduce(initialState(snapshot()), "tool_call_started", { messageId: "m0", call: call() })
    state = reduce(state, "tool_call_finished", {
      result: { toolCallId: "call-1", status: "failed", output: "no such file", truncated: false },
    })

    expect(calls(state)).toEqual([call({ status: "failed" })])
  })

  test("a result for a call nobody is holding changes nothing", () => {
    const state = reduce(initialState(snapshot()), "tool_call_started", { messageId: "m0", call: call() })
    const after = reduce(state, "tool_call_finished", {
      result: { toolCallId: "call-elsewhere", status: "succeeded", output: "", truncated: false },
    })

    expect(after).toBe(state)
  })
})

describe("approval state follows the matching tool", () => {
  const request = () => ({
    id: "approval-1",
    sessionId: SESSION,
    call: call({ status: "pending_approval" as const }),
    reason: "workspace_untrusted" as const,
    requestedAt: 11,
  })

  test("a request moves a running call to pending, then an allow resumes it", () => {
    let state = reduce(initialState(snapshot()), "tool_call_started", { messageId: "m0", call: call() })
    state = reduce(state, "approval_requested", { request: request() })
    expect(calls(state)[0]?.status).toBe("pending_approval")

    state = reduce(state, "approval_resolved", {
      requestId: "approval-1",
      decision: "allow_once",
      resolvedBy: "user",
    })
    expect(calls(state)[0]?.status).toBe("running")
  })

  test("a user denial stays denied when Pi reports the blocked call as an error", () => {
    let state = reduce(initialState(snapshot()), "tool_call_started", { messageId: "m0", call: call() })
    state = reduce(state, "approval_requested", { request: request() })
    state = reduce(state, "approval_resolved", {
      requestId: "approval-1",
      decision: "deny",
      resolvedBy: "user",
    })
    state = reduce(state, "tool_call_finished", {
      result: { toolCallId: "call-1", status: "failed", output: "blocked", truncated: false },
    })

    expect(calls(state)[0]?.status).toBe("denied")
  })

  test("a cancelled approval marks the call aborted rather than denied", () => {
    let state = reduce(initialState(snapshot()), "tool_call_started", { messageId: "m0", call: call() })
    state = reduce(state, "approval_requested", { request: request() })
    state = reduce(state, "approval_resolved", {
      requestId: "approval-1",
      decision: "deny",
      resolvedBy: "cancelled",
    })
    state = reduce(state, "tool_call_finished", {
      result: { toolCallId: "call-1", status: "failed", output: "cancelled", truncated: false },
    })

    expect(calls(state)[0]?.status).toBe("aborted")
  })
})

describe("announcements the snapshot cannot carry", () => {
  test("compaction says how many messages it removed", () => {
    const state = reduce(initialState(snapshot()), "compaction_finished", { removedMessages: 42 })
    expect(state.notice).toEqual({ kind: "compacted", removedMessages: 42 })
  })

  /**
   * The order the host emits in is status, then the count, then the snapshot
   * that replaces history. A projection that reset the notice on a snapshot
   * would erase the explanation for the messages the snapshot just dropped.
   */
  test("the notice survives the snapshot that follows it", () => {
    let state = reduce(initialState(snapshot()), "compaction_finished", { removedMessages: 42 })
    state = reduce(state, "session_snapshot", { snapshot: { ...snapshot(), sequence: 9, messages: [] } })

    expect(state.notice).toEqual({ kind: "compacted", removedMessages: 42 })
    expect(state.snapshot.messages).toEqual([])
  })

  test("a retry is recorded with its attempt and delay, rather than stalling silently", () => {
    const state = reduce(initialState(snapshot()), "retry_scheduled", { attempt: 2, delayMs: 1500, reason: "429 from the provider" })
    expect(state.notice).toEqual({ kind: "retrying", attempt: 2, delayMs: 1500, reason: "429 from the provider" })
  })

  test("the next turn clears it, because it described the last one", () => {
    let state = reduce(initialState(snapshot()), "retry_scheduled", { attempt: 2, delayMs: 1500, reason: "429" })
    state = reduce(state, "turn_started", { messageId: "m1" })

    expect(state.notice).toBeUndefined()
  })

  test("a turn beginning with nothing to clear leaves the projection alone", () => {
    const state = initialState(snapshot())
    expect(reduce(state, "turn_started", { messageId: "m1" })).toBe(state)
  })
})

test("message events use the projection index instead of rescanning history", () => {
  const messages = Array.from({ length: 2_000 }, (_, index) => ({
    id: `m${index}`,
    role: "assistant" as const,
    status: "streaming" as const,
    blocks: [{ index: 0, kind: "text" as const, text: "" }],
    createdAt: index,
  }))
  Object.defineProperty(messages, "findIndex", {
    value: () => {
      throw new Error("message history was rescanned")
    },
  })

  let state = initialState({ ...snapshot(), messages })
  state = reduce(state, "block_delta", { messageId: "m1999", blockIndex: 0, textDelta: "last" })
  state = reduce(state, "session_status_changed", { status: "idle" })
  state = reduce(state, "block_delta", { messageId: "m1999", blockIndex: 0, textDelta: " message" })

  expect(state.snapshot.messages[1_999]?.blocks[0]).toEqual({ index: 0, kind: "text", text: "last message" })
})

test("tool updates use the call index instead of rescanning history", () => {
  const messages = Array.from({ length: 2_000 }, (_, index) => ({
    id: `m${index}`,
    role: "assistant" as const,
    status: "complete" as const,
    blocks: index === 1_999 ? [{ index: 0, kind: "tool_call" as const, call: call() }] : [],
    createdAt: index,
  }))
  const state = initialState({ ...snapshot(), messages })
  Object.defineProperty(messages, "findIndex", {
    value: () => {
      throw new Error("message history was rescanned")
    },
  })

  const updated = reduce(state, "tool_call_updated", { call: call({ partialOutput: "indexed" }) })

  expect(calls(updated)[0]?.partialOutput).toBe("indexed")
})

/**
 * The table is the reason a new session event cannot be dropped by omission.
 * Its type already forces an entry per event; this is what keeps the entries
 * from drifting to events that no longer exist, and what keeps the table
 * pointed at session events rather than growing into the store's business.
 */
test("the projection table names exactly the contract's session events", () => {
  expect(Object.keys(PROJECTION).sort()).toEqual([...SESSION_SCOPED_EVENTS].sort())
})

test("every entry says what happens, not merely that something does", () => {
  for (const [name, reason] of Object.entries(PROJECTION)) {
    expect(reason.length, `${name} is explained`).toBeGreaterThan(24)
  }
})
