import { describe, expect, test } from "bun:test"
import { projectTodoState } from "./todo.ts"

describe("todo result projection", () => {
  test("keeps the current list in a compact renderer-safe shape", () => {
    expect(projectTodoState("todo", {
      action: "toggle",
      nextId: 4,
      todos: [
        { id: 1, text: "Inspect the current flow", done: true },
        { id: 2, text: "Wire the question card", done: false },
        { id: "deploy", text: "Verify the build", status: "in_progress" },
      ],
    })).toEqual({
      items: [
        { id: "1", text: "Inspect the current flow", status: "completed" },
        { id: "2", text: "Wire the question card", status: "pending" },
        { id: "deploy", text: "Verify the build", status: "in_progress" },
      ],
    })
  })

  test("leaves unrelated and malformed extension details opaque", () => {
    expect(projectTodoState("other", { todos: [] })).toBeUndefined()
    expect(projectTodoState("todo", { todos: [{ id: 1, done: false }] })).toBeUndefined()
    expect(projectTodoState("todo", { todos: [{ id: 1, text: "Task", status: "blocked" }] })).toBeUndefined()
  })

  test("preserves an empty list so a clear action removes stale UI", () => {
    expect(projectTodoState("todo", { todos: [] })).toEqual({ items: [] })
  })
})
