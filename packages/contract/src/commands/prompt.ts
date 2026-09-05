import { type Static, Type } from "@sinclair/typebox"
import { AbsolutePath, SessionId } from "../dto/primitives.ts"
import { QueuedPrompt } from "../dto/session.ts"
import { WorkspaceRuntime } from "../dto/workspace.ts"
import { defineCommands } from "./define.ts"

/** Attachments are referenced by path and read by the host. Renderer-side bytes never cross. */
export const Attachment = Type.Object({
  path: AbsolutePath,
  mediaType: Type.String({ maxLength: 128 }),
  bytes: Type.Integer({ minimum: 0, maximum: 20_971_520 }),
})
export type Attachment = Static<typeof Attachment>

const promptText = Type.String({ minLength: 1, maxLength: 1_048_576 })
const attachments = Type.Array(Attachment, { maxItems: 16 })

export const promptCommands = defineCommands({
  /** Main-owned native picker. Cancel is an empty array, not an error. */
  choose_attachments: {
    params: Type.Object({ workspaceRoot: AbsolutePath, runtime: WorkspaceRuntime }),
    result: Type.Object({ attachments: Type.Array(Attachment, { maxItems: 16 }) }),
  },
  prompt: {
    params: Type.Object({
      sessionId: SessionId,
      text: promptText,
      attachments,
    }),
    /** Queued when a turn is already running. Pi owns the queue; we report which happened. */
    result: Type.Object({ accepted: Type.Boolean(), queued: Type.Boolean() }),
  },
  /** Injects guidance into the running turn without waiting for it to settle. */
  steer: {
    params: Type.Object({ sessionId: SessionId, text: promptText, attachments: Type.Optional(attachments) }),
    result: Type.Object({ accepted: Type.Boolean() }),
  },
  /** Appends to the queue explicitly, even when the session is idle. */
  follow_up: {
    params: Type.Object({ sessionId: SessionId, text: promptText, attachments: Type.Optional(attachments) }),
    result: Type.Object({ queued: Type.Boolean() }),
  },
  /** Stops the turn and returns every prompt removed from Pi's queues so the editor can restore it. */
  abort: {
    params: Type.Object({ sessionId: SessionId }),
    result: Type.Object({ aborted: Type.Boolean(), recovered: Type.Array(QueuedPrompt) }),
  },
  get_queue: { params: Type.Object({ sessionId: SessionId }), result: Type.Object({ queue: Type.Array(QueuedPrompt) }) },
})
