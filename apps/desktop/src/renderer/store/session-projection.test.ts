import { describe, expect, test } from "bun:test"
import type { SessionSnapshot, ToolCall } from "@bake-pi/contract"
import { SessionProjection, type SessionViews } from "./session-projection.ts"

const SESSION = "00000000-0000-4000-8000-000000000001"

const snapshot = (overrides: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  sequence: 1,
  summary: {
    id: SESSION,
    workspaceId: "workspace-1",
    title: "projection",
    createdAt: 1,
    updatedAt: 1,
    messageCount: 2,
    path: "C:\\workspace\\session.jsonl",
  },
  status: "streaming",
  messages: [
    { id: "m0", role: "user", status: "complete", blocks: [{ index: 0, kind: "text", text: "hello" }], createdAt: 1 },
    { id: "m1", role: "assistant", status: "streaming", blocks: [{ index: 0, kind: "text", text: "hi" }], createdAt: 2 },
  ],
  queue: [],
  approvals: [],
  model: { providerId: "fixture", modelId: "fixture", thinkingLevel: "off", availableThinkingLevels: ["off"] },
  usage: { turnCount: 0, total: { inputTokens: 0, outputTokens: 0 } },
  afterGap: false,
  ...overrides,
})

const subscriptions = (projection: SessionProjection): Record<keyof SessionViews, number> => {
  const notifications = { core: 0, timeline: 0, activity: 0, approvals: 0, todo: 0 }
  for (const name of Object.keys(notifications) as (keyof SessionViews)[]) {
    projection.view(name).subscribe(() => { notifications[name] += 1 })
  }
  return notifications
}

const call = (status: ToolCall["status"] = "running"): ToolCall => ({
  id: "call-1",
  name: "read",
  source: "builtin",
  args: { path: "C:\\workspace\\value.ts" },
  targets: [{ path: "C:\\workspace\\value.ts", insideWorkspace: true, kind: "read" }],
  status,
  startedAt: 2,
})

describe("named session views", () => {
  test("a text delta publishes only the timeline and retains completed rows", () => {
    const projection = new SessionProjection(snapshot())
    const notifications = subscriptions(projection)
    const before = projection.view("timeline").getSnapshot()

    projection.apply("block_delta", { messageId: "m1", blockIndex: 0, textDelta: " there" })

    const after = projection.view("timeline").getSnapshot()
    expect(notifications).toEqual({ core: 0, timeline: 1, activity: 0, approvals: 0, todo: 0 })
    expect(after.rows).toBe(before.rows)
    expect(after.active?.blocks[0]).toEqual({ index: 0, kind: "text", text: "hi there" })
  })

  test("adding a message retains unchanged row identities", () => {
    const projection = new SessionProjection(snapshot())
    const before = projection.view("timeline").getSnapshot().rows
    const message = {
      id: "m2",
      role: "user" as const,
      status: "complete" as const,
      blocks: [{ index: 0, kind: "text" as const, text: "another turn" }],
      createdAt: 3,
    }

    projection.apply("message_added", { message })

    const after = projection.view("timeline").getSnapshot().rows
    expect(after).toHaveLength(2)
    expect(after[0]).toBe(before[0])
    expect(after[1]?.message).toBe(message)
  })

  test("session metadata does not wake the timeline", () => {
    const projection = new SessionProjection(snapshot())
    const notifications = subscriptions(projection)

    projection.apply("session_status_changed", { status: "idle" })

    expect(notifications).toEqual({ core: 1, timeline: 0, activity: 0, approvals: 0, todo: 0 })
    expect(projection.view("core").getSnapshot().snapshot.status).toBe("idle")
  })

  test("tool updates use the indexed call and publish timeline and activity only", () => {
    const withCall = snapshot({
      messages: [
        snapshot().messages[0]!,
        {
          ...snapshot().messages[1]!,
          blocks: [{ index: 0, kind: "tool_call", call: call() }],
        },
      ],
    })
    const projection = new SessionProjection(withCall)
    const notifications = subscriptions(projection)

    projection.apply("tool_call_updated", { call: { ...call(), partialOutput: "value" } })

    expect(notifications).toEqual({ core: 0, timeline: 1, activity: 1, approvals: 0, todo: 0 })
    expect(projection.view("timeline").getSnapshot().calls.get("call-1")?.partialOutput).toBe("value")
    expect(projection.view("activity").getSnapshot().calls[0]?.partialOutput).toBe("value")
  })

  test("an authoritative snapshot rebuilds every disposable derivation", () => {
    const projection = new SessionProjection(snapshot({
      messages: [{ ...snapshot().messages[1]!, blocks: [{ index: 0, kind: "tool_call", call: call() }] }],
    }))
    const oldRows = projection.view("timeline").getSnapshot().rows
    const notifications = subscriptions(projection)
    const replacement = snapshot({
      sequence: 9,
      status: "idle",
      messages: [{
        id: "m9",
        role: "system",
        status: "complete",
        blocks: [{
          index: 0,
          kind: "tool_result",
          result: {
            toolCallId: "todo-call",
            status: "succeeded",
            output: "",
            truncated: false,
            todo: { items: [{ id: "one", text: "Ship it", status: "in_progress" }] },
          },
        }],
        createdAt: 9,
      }],
    })

    projection.apply("session_snapshot", { snapshot: replacement })

    expect(notifications).toEqual({ core: 1, timeline: 1, activity: 1, approvals: 1, todo: 1 })
    expect(projection.state().snapshot).toEqual(replacement)
    expect(projection.view("timeline").getSnapshot().rows).not.toBe(oldRows)
    expect(projection.view("timeline").getSnapshot().calls.get("call-1")).toBeUndefined()
    expect(projection.view("todo").getSnapshot()?.items[0]?.text).toBe("Ship it")
  })
})
