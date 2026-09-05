import type { Message, TodoState } from "@bake-pi/contract"

/**
 * The current todo list is the last one Pi persisted on this branch.
 *
 * Walking backwards stops at the first recognized result, including an empty
 * result from `clear`. Keeping this as a derivation means a snapshot, resync or
 * branch replacement updates the card without renderer-owned task state.
 */
export const currentTodoState = (messages: readonly Message[]): TodoState | undefined => {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const blocks = messages[messageIndex]!.blocks
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = blocks[blockIndex]!
      if (block.kind === "tool_result" && block.result.todo !== undefined) return block.result.todo
    }
  }
  return undefined
}

/**
 * What counts as done, decided once.
 *
 * The step caption under a todo call and the tray beside the turn both report
 * this number, and a plan that read "2 of 5" in one place and "3 of 5" in the
 * other would be the renderer disagreeing with itself about the same result.
 */
export const todoCompleted = (todo: TodoState): number =>
  todo.items.filter((item) => item.status === "completed").length

/** The same count as a caption, worded once. */
export const todoProgress = (todo: TodoState): string =>
  `${String(todoCompleted(todo))} of ${String(todo.items.length)} complete`
