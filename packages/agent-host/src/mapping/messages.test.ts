import { expect, test } from "bun:test"
import type { ToolResultMessage } from "@earendil-works/pi-ai"
import { projectMessage } from "./messages.ts"

test("a persisted todo result restores the current list on a snapshot", () => {
  const message: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "todo-1",
    toolName: "todo",
    content: [{ type: "text", text: "Added todo #1" }],
    details: { action: "add", nextId: 2, todos: [{ id: 1, text: "Verify the build", done: false }] },
    isError: false,
    timestamp: 1,
  }

  expect(projectMessage(message, 2, { workspaceRoot: "D:\\workspace" }).blocks).toEqual([{
    index: 0,
    kind: "tool_result",
    result: {
      toolCallId: "todo-1",
      status: "succeeded",
      output: "Added todo #1",
      truncated: false,
      todo: { items: [{ id: "1", text: "Verify the build", status: "pending" }] },
    },
  }])
})
