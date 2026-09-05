import { type Static, Type } from "@sinclair/typebox"

/**
 * A compact presentation of a todo tool result.
 *
 * The extension's complete result remains in Pi's session entry. Bake Pi only
 * carries the fields its renderer understands, so arbitrary extension details
 * never become an accidental second public contract.
 */
export const TodoItem = Type.Object({
  id: Type.String({ maxLength: 64 }),
  text: Type.String({ maxLength: 4096 }),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("in_progress"),
    Type.Literal("completed"),
  ]),
})
export type TodoItem = Static<typeof TodoItem>

export const TodoState = Type.Object({
  items: Type.Array(TodoItem, { maxItems: 256 }),
})
export type TodoState = Static<typeof TodoState>
