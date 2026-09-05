import { type Static, Type } from "@sinclair/typebox"

const id = (maxLength = 128) => Type.String({ minLength: 1, maxLength })

export const SessionId = id()
export type SessionId = Static<typeof SessionId>

export const MessageId = id()
export type MessageId = Static<typeof MessageId>

export const ToolCallId = id()
export type ToolCallId = Static<typeof ToolCallId>

export const RequestId = id(64)
export type RequestId = Static<typeof RequestId>

export const WorkspaceId = id()
export type WorkspaceId = Static<typeof WorkspaceId>

/** Milliseconds since the Unix epoch. Never a formatted date: formatting is the renderer's locale problem. */
export const Timestamp = Type.Integer({ minimum: 0 })
export type Timestamp = Static<typeof Timestamp>

/**
 * Session-scoped, strictly monotonic. A snapshot carries the sequence it was
 * taken at; the renderer discards buffered events at or below it and applies
 * only those above. This one number is what makes the stream resyncable.
 */
export const Sequence = Type.Integer({ minimum: 0 })
export type Sequence = Static<typeof Sequence>

/** An absolute path as the host resolved it. The renderer displays; it never re-resolves. */
export const AbsolutePath = Type.String({ minLength: 1, maxLength: 4096 })
export type AbsolutePath = Static<typeof AbsolutePath>
