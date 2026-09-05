import { type Static, Type } from "@sinclair/typebox"
import { SessionId, Timestamp } from "./primitives.ts"
import { ToolCall } from "./tool.ts"

/**
 * The approval policy is three rules, so the card can state the reason in one
 * line and the user can predict the next prompt. Anything more elaborate
 * teaches people to click through.
 */
export const ApprovalReason = Type.Union([
  /** The workspace is untrusted, so every tool asks. */
  Type.Literal("workspace_untrusted"),
  /** The tool writes or executes outside the workspace root. */
  Type.Literal("outside_workspace"),
  /**
   * The host cannot tell what the tool will touch, so it cannot apply the other
   * two rules. This is what an extension-contributed tool looks like to a
   * policy that only understands Pi's built-in tool arguments. Asking is the
   * only answer that does not amount to guessing on the user's behalf.
   */
  Type.Literal("targets_unknown"),
])
export type ApprovalReason = Static<typeof ApprovalReason>

export const ApprovalRequest = Type.Object({
  id: Type.String({ maxLength: 64 }),
  sessionId: SessionId,
  call: ToolCall,
  reason: ApprovalReason,
  requestedAt: Timestamp,
})
export type ApprovalRequest = Static<typeof ApprovalRequest>

export const ApprovalDecision = Type.Union([
  Type.Literal("allow_once"),
  /** Scoped to this session and this tool name. Never persisted to disk. */
  Type.Literal("allow_for_session"),
  Type.Literal("deny"),
])
export type ApprovalDecision = Static<typeof ApprovalDecision>
