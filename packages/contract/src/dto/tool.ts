import { type Static, Type } from "@sinclair/typebox"
import { ContractError } from "../errors.ts"
import { AbsolutePath, Timestamp, ToolCallId } from "./primitives.ts"
import { TodoState } from "./todo.ts"

/**
 * Tool arguments are Pi's shape, not ours. We carry them as an opaque JSON
 * value and render them structurally. Parsing them into our own types would
 * make every upstream tool addition a Bake Pi change.
 */
export const JsonValue = Type.Unknown()

export const ToolCallStatus = Type.Union([
  Type.Literal("pending_approval"),
  Type.Literal("running"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("denied"),
  Type.Literal("aborted"),
])
export type ToolCallStatus = Static<typeof ToolCallStatus>

/**
 * A file the tool intends to touch, canonicalized by the host. The approval
 * card renders these; the policy decides on them. The renderer sees the result
 * of canonicalization, never a raw argument it might normalize differently.
 */
export const ToolTarget = Type.Object({
  path: AbsolutePath,
  insideWorkspace: Type.Boolean(),
  kind: Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("execute")]),
})
export type ToolTarget = Static<typeof ToolTarget>

export const ToolCall = Type.Object({
  id: ToolCallId,
  name: Type.String({ maxLength: 128 }),
  /** Upstream tool, or a tool contributed by a loaded extension. Extensions are flagged in the UI. */
  source: Type.Union([Type.Literal("builtin"), Type.Literal("extension")]),
  extensionName: Type.Optional(Type.String({ maxLength: 128 })),
  args: JsonValue,
  targets: Type.Array(ToolTarget, { maxItems: 256 }),
  status: ToolCallStatus,
  startedAt: Type.Optional(Timestamp),
  endedAt: Type.Optional(Timestamp),
  /**
   * Output the tool has produced so far, while it is still running. Pi reports
   * it as a cumulative snapshot rather than a delta, so this field replaces
   * rather than appends — the same reason `block_delta` does not carry it.
   * Capped well below the final result's cap: a running tool can emit updates
   * many times a second, and the tail is the part anyone is watching.
   */
  partialOutput: Type.Optional(Type.String({ maxLength: 65_536 })),
})
export type ToolCall = Static<typeof ToolCall>

export const ToolResult = Type.Object({
  toolCallId: ToolCallId,
  status: ToolCallStatus,
  /** Truncated by the host to the per-event cap; `truncated` says so honestly. */
  output: Type.String({ maxLength: 262_144 }),
  truncated: Type.Boolean(),
  error: Type.Optional(ContractError),
  /** Present only when a recognized todo result exposed a valid current list. */
  todo: Type.Optional(TodoState),
})
export type ToolResult = Static<typeof ToolResult>
