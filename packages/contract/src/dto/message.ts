import { type Static, Type } from "@sinclair/typebox"
import { ContentBlock } from "./block.ts"
import { MessageId, Timestamp } from "./primitives.ts"
import { TokenUsage } from "./usage.ts"

export const MessageRole = Type.Union([
  Type.Literal("user"),
  Type.Literal("assistant"),
  Type.Literal("system"),
])
export type MessageRole = Static<typeof MessageRole>

export const MessageStatus = Type.Union([
  Type.Literal("streaming"),
  Type.Literal("complete"),
  Type.Literal("aborted"),
  Type.Literal("failed"),
])
export type MessageStatus = Static<typeof MessageStatus>

export const Message = Type.Object({
  id: MessageId,
  role: MessageRole,
  status: MessageStatus,
  blocks: Type.Array(ContentBlock),
  createdAt: Timestamp,
  /** Present once the turn settles. Absent while streaming — not zero, which would render as a real number. */
  usage: Type.Optional(TokenUsage),
  /** The model that produced this message. Sessions can change model mid-conversation. */
  modelId: Type.Optional(Type.String({ maxLength: 128 })),
})
export type Message = Static<typeof Message>
