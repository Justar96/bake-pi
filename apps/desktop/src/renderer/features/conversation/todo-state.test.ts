import { describe, expect, test } from "bun:test"
import type { Message, TodoState } from "@bake-pi/contract"
import { currentTodoState } from "./todo-state.ts"

const result = (id: string, todo: TodoState): Message => ({
  id,
  role: "system",
  status: "complete",
  createdAt: 1,
  blocks: [{
    index: 0,
    kind: "tool_result",
    result: { toolCallId: id, status: "succeeded", output: "", truncated: false, todo },
  }],
})

describe("current todo state", () => {
  test("uses the last list Pi persisted on the branch", () => {
    const old = { items: [{ id: "1", text: "Old", status: "pending" as const }] }
    const current = { items: [{ id: "1", text: "Current", status: "completed" as const }] }
    expect(currentTodoState([result("old", old), result("current", current)])).toEqual(current)
  })

  test("an empty clear result wins over an older non-empty list", () => {
    const old = { items: [{ id: "1", text: "Old", status: "pending" as const }] }
    expect(currentTodoState([result("old", old), result("clear", { items: [] })])).toEqual({ items: [] })
  })

  test("has no state when Pi has not persisted a recognized todo result", () => {
    expect(currentTodoState([])).toBeUndefined()
  })
})
