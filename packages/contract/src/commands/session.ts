import { Type } from "@sinclair/typebox"
import { MessageId, SessionId, WorkspaceId } from "../dto/primitives.ts"
import { SessionSnapshot, SessionSummary } from "../dto/session.ts"
import { defineCommands } from "./define.ts"

const sessionRef = Type.Object({ sessionId: SessionId })

/**
 * Every command that attaches or replaces a session answers with a snapshot
 * rather than an identifier alone. Pi replaces the live `AgentSession` object on
 * new, switch, fork, clone and import, so "the session changed" and "here is its
 * authoritative state" are the same event and should be one round trip.
 */
const snapshotResult = Type.Object({ snapshot: SessionSnapshot })

export const sessionCommands = defineCommands({
  list_sessions: {
    params: Type.Object({ workspaceId: WorkspaceId }),
    result: Type.Object({ sessions: Type.Array(SessionSummary) }),
  },
  create_session: { params: Type.Object({ workspaceId: WorkspaceId }), result: snapshotResult },
  open_session: { params: sessionRef, result: snapshotResult },
  /** Starts a fresh session in the same workspace and detaches the current one. */
  new_session: { params: Type.Object({ workspaceId: WorkspaceId }), result: snapshotResult },
  fork_session: { params: Type.Object({ sessionId: SessionId, atMessageId: MessageId }), result: snapshotResult },
  clone_session: { params: sessionRef, result: snapshotResult },
  /** Moves the head within Pi's persisted session tree. */
  navigate_tree: { params: Type.Object({ sessionId: SessionId, toMessageId: MessageId }), result: snapshotResult },
  compact_session: { params: sessionRef, result: Type.Object({ started: Type.Boolean() }) },
  close_session: { params: sessionRef, result: Type.Object({}) },
  /**
   * Asks for a fenced snapshot after the renderer detected a gap in the stream.
   *
   * It answers with nothing on purpose. The snapshot travels as a
   * `session_snapshot` event because only the event carries the sequence it was
   * taken at, and that fence is the whole mechanism: a snapshot returned here
   * would arrive without one, and a caller applying it could not tell which
   * concurrently delivered events it already contains.
   */
  resync_session: { params: sessionRef, result: Type.Object({}) },
})
