import { type Static, Type } from "@sinclair/typebox"
import { Value } from "@sinclair/typebox/value"
import { ContractError } from "./errors.ts"
import { RequestId, Sequence, SessionId } from "./dto/primitives.ts"

/**
 * Envelopes travel either by structured clone over a `MessagePort` or as one
 * JSON value per loopback WebSocket frame. Framing belongs to the transport:
 * there is no application length prefix or byte stream that a `console.log`
 * inside a user extension can desynchronize. Program output stays on the
 * launcher's diagnostic pipe and is never parsed after the one WSL startup
 * line.
 *
 * `params`, `result` and `payload` are `Unknown` here on purpose. The envelope
 * only routes; the per-command and per-event schemas validate the body, and
 * doing both in one step would mean one giant union recompiled on every change.
 */
export const CommandEnvelope = Type.Object({
  kind: Type.Literal("command"),
  id: RequestId,
  name: Type.String({ maxLength: 64 }),
  params: Type.Unknown(),
})
export type CommandEnvelope = Static<typeof CommandEnvelope>

export const ResponseEnvelope = Type.Union([
  Type.Object({ kind: Type.Literal("response"), id: RequestId, ok: Type.Literal(true), result: Type.Unknown() }),
  Type.Object({ kind: Type.Literal("response"), id: RequestId, ok: Type.Literal(false), error: ContractError }),
])
export type ResponseEnvelope = Static<typeof ResponseEnvelope>

export const EventEnvelope = Type.Object({
  kind: Type.Literal("event"),
  name: Type.String({ maxLength: 64 }),
  /**
   * Session-scoped and strictly monotonic. Snapshots carry the sequence they
   * were taken at; the renderer discards buffered events at or below it.
   * Host-scoped events carry the host's own counter.
   */
  sequence: Sequence,
  sessionId: Type.Optional(SessionId),
  payload: Type.Unknown(),
})
export type EventEnvelope = Static<typeof EventEnvelope>

/**
 * The most credit one ack may return, and therefore the most the renderer may
 * ask for in one message. Both ends of the window are stated here for the same
 * reason the byte cap is: an emitter that refuses an ack the renderer keeps
 * sending stalls the credit loop in silence, because the guard's contract is to
 * return false rather than to complain.
 */
export const MAX_EVENT_ACK_COUNT = 4_096

/** Receiver credit returned on the same MessagePort as the event stream. */
export const EventDeliveryAck = Type.Object({
  kind: Type.Literal("event_ack"),
  count: Type.Integer({ minimum: 1, maximum: MAX_EVENT_ACK_COUNT }),
})
export type EventDeliveryAck = Static<typeof EventDeliveryAck>

export const isEventDeliveryAck = (value: unknown): value is EventDeliveryAck =>
  Value.Check(EventDeliveryAck, value)

export type Envelope = CommandEnvelope | ResponseEnvelope | EventEnvelope

/** Beyond this a payload is refused rather than truncated: a silently shortened tool result is a wrong tool result. */
export const MAX_ENVELOPE_BYTES = 8 * 1024 * 1024

/** Per host stream. Breaching it names each affected session and forces snapshot resyncs. */
export const MAX_QUEUED_SESSION_BYTES = 16 * 1024 * 1024
