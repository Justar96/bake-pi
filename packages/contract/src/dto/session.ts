import { type Static, Type } from "@sinclair/typebox"
import { Message } from "./message.ts"
import { ModelSelection } from "./model.ts"
import { AbsolutePath, MessageId, Sequence, SessionId, Timestamp, WorkspaceId } from "./primitives.ts"
import { SessionUsage } from "./usage.ts"
import { ApprovalRequest } from "./approval.ts"

export const SessionStatus = Type.Union([
  Type.Literal("idle"),
  Type.Literal("streaming"),
  Type.Literal("awaiting_approval"),
  Type.Literal("compacting"),
  Type.Literal("retrying"),
  /** The host died. Mutations are refused; history still renders. */
  Type.Literal("disconnected"),
  /** The host crashed on this session and it was excluded from restart. */
  Type.Literal("quarantined"),
])
export type SessionStatus = Static<typeof SessionStatus>

/** What the session list shows. Cheap enough to hold for every session in a workspace. */
export const SessionSummary = Type.Object({
  id: SessionId,
  workspaceId: WorkspaceId,
  title: Type.String({ maxLength: 512 }),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  messageCount: Type.Integer({ minimum: 0 }),
  path: AbsolutePath,
  /** Pi persists sessions as a tree. A forked session names its parent. */
  parentId: Type.Optional(SessionId),
})
export type SessionSummary = Static<typeof SessionSummary>

export const QueuedPrompt = Type.Object({
  id: Type.String({ maxLength: 64 }),
  text: Type.String(),
  /** Which Pi queue owns the prompt; delivery order alone cannot recover this after an abort. */
  mode: Type.Union([Type.Literal("steer"), Type.Literal("follow_up")]),
  queuedAt: Timestamp,
})
export type QueuedPrompt = Static<typeof QueuedPrompt>

/**
 * The authoritative projection of a session.
 *
 * `sequence` is the fence: it is the sequence number this snapshot was taken
 * at. The renderer replaces its projection wholesale, discards buffered events
 * at or below `sequence`, and applies only those above. That is what makes a
 * gap recoverable without buffering without limit.
 */
export const SessionSnapshot = Type.Object({
  sequence: Sequence,
  summary: SessionSummary,
  status: SessionStatus,
  messages: Type.Array(Message),
  queue: Type.Array(QueuedPrompt),
  /** Tool calls Pi is still blocking on, so a renderer reload can restore every approval card. */
  approvals: Type.Array(ApprovalRequest),
  model: ModelSelection,
  usage: SessionUsage,
  /** Set when the snapshot follows a discarded buffer, so the UI can say why history jumped. */
  afterGap: Type.Boolean(),
  /** Head of Pi's session tree as currently navigated. */
  headMessageId: Type.Optional(MessageId),
})
export type SessionSnapshot = Static<typeof SessionSnapshot>
