import type { TodoItem, TodoState } from "@bake-pi/contract"

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

/**
 * Reads the persisted details shape of Pi's todo extension example.
 *
 * Tool details are extension-owned and otherwise opaque. Matching both the
 * tool name and every field keeps a different extension called `todo` on the
 * generic rendering path instead of inventing task state from similar data.
 */
export const projectTodoState = (toolName: string, details: unknown): TodoState | undefined => {
  if (toolName.toLowerCase() !== "todo") return undefined
  const raw = asRecord(details)?.todos
  if (!Array.isArray(raw)) return undefined

  const items: TodoItem[] = []
  for (const [index, value] of raw.slice(0, 256).entries()) {
    const item = asRecord(value)
    if (item === undefined || typeof item.text !== "string" || item.text.length === 0) return undefined

    const id = typeof item.id === "string" || typeof item.id === "number"
      ? String(item.id).slice(0, 64)
      : String(index + 1)
    const status = item.status === "in_progress"
      ? "in_progress"
      : item.status === "completed" || item.done === true
        ? "completed"
        : item.status === undefined || item.status === "pending" || item.done === false
          ? "pending"
          : undefined
    if (id.length === 0 || status === undefined) return undefined
    items.push({ id, text: item.text.slice(0, 4096), status })
  }
  return { items }
}
