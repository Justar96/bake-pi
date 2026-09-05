import { Type } from "@sinclair/typebox"
import { ContentBlock } from "../dto/block.ts"
import { Message, MessageStatus } from "../dto/message.ts"
import { ModelSelection } from "../dto/model.ts"
import { MessageId, SessionId } from "../dto/primitives.ts"
import { QueuedPrompt, SessionSnapshot, SessionStatus, SessionSummary } from "../dto/session.ts"
import { SessionUsage, TokenUsage } from "../dto/usage.ts"
import { ToolCall, ToolResult } from "../dto/tool.ts"
import { defineEvents } from "./define.ts"

export const sessionEvents = defineEvents({
  /**
   * The authoritative reset. Sent on attach, after Pi replaces the live session
   * object, and after a discarded buffer. Carries the sequence it was taken at.
   */
  session_snapshot: Type.Object({ snapshot: SessionSnapshot }),
  session_status_changed: Type.Object({ status: SessionStatus }),
  session_summary_changed: Type.Object({ summary: SessionSummary }),

  turn_started: Type.Object({ messageId: MessageId }),
  turn_settled: Type.Object({ messageId: MessageId, status: MessageStatus, usage: Type.Optional(TokenUsage) }),

  message_added: Type.Object({ message: Message }),
  /** A block appeared on a streaming message. The full block, so the renderer never guesses at a partial shape. */
  block_started: Type.Object({ messageId: MessageId, block: ContentBlock }),
  /**
   * Append-only delta addressed by block index. Text and reasoning stream this
   * way; structural blocks do not, because a half-parsed tool call is not
   * something the renderer should ever hold.
   */
  block_delta: Type.Object({
    messageId: MessageId,
    blockIndex: Type.Integer({ minimum: 0 }),
    textDelta: Type.String({ maxLength: 65_536 }),
  }),
  block_finished: Type.Object({ messageId: MessageId, block: ContentBlock }),

  tool_call_started: Type.Object({ messageId: MessageId, call: ToolCall }),
  tool_call_updated: Type.Object({ call: ToolCall }),
  tool_call_finished: Type.Object({ result: ToolResult }),

  queue_changed: Type.Object({ queue: Type.Array(QueuedPrompt) }),
  usage_changed: Type.Object({ usage: SessionUsage }),
  model_changed: Type.Object({ selection: ModelSelection }),

  compaction_started: Type.Object({}),
  compaction_finished: Type.Object({ removedMessages: Type.Integer({ minimum: 0 }) }),

  /** Pi is retrying a provider call. Shown, not hidden: a silent stall is indistinguishable from a hang. */
  retry_scheduled: Type.Object({
    attempt: Type.Integer({ minimum: 1 }),
    delayMs: Type.Integer({ minimum: 0 }),
    reason: Type.String({ maxLength: 256 }),
  }),

  /**
   * Events for this session were dropped and will never be delivered. A
   * fenced snapshot follows.
   *
   * This event exists so the gap is stated rather than inferred. The host emits
   * it when its pre-connection buffer breaches the byte cap; the renderer
   * raises the same condition against itself when a sequence number is missing,
   * because an event lost to a failed schema check is a gap the host has no way
   * to know about.
   */
  stream_gap: Type.Object({ sessionId: SessionId, droppedEvents: Type.Integer({ minimum: 0 }) }),
})
