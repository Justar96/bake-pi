import { Type } from "@sinclair/typebox"
import { ContractError } from "../errors.ts"
import { SessionId } from "../dto/primitives.ts"
import { defineEvents } from "./define.ts"

export const lifecycleEvents = defineEvents({
  host_ready: Type.Object({ piVersion: Type.String({ maxLength: 64 }) }),
  /** Best-effort awareness only; failure or offline mode emits nothing. */
  pi_update_available: Type.Object({
    currentVersion: Type.String({ maxLength: 64 }),
    latestVersion: Type.String({ maxLength: 64 }),
  }),
  /** Emitted before the host stops accepting commands, so the UI can say why rather than showing a hang. */
  host_shutting_down: Type.Object({ reason: Type.Union([Type.Literal("requested"), Type.Literal("fatal")]) }),
  /** Periodic and cheap. Deliberately not a request/response ping: health must not queue behind a token stream. */
  host_health: Type.Object({
    at: Type.Integer({ minimum: 0 }),
    residentBytes: Type.Integer({ minimum: 0 }),
    attachedSessions: Type.Integer({ minimum: 0 }),
    queuedOutboundBytes: Type.Integer({ minimum: 0 }),
  }),
  session_disconnected: Type.Object({ sessionId: SessionId, quarantined: Type.Boolean() }),
  /** Recoverable: the UI shows it and the session continues. */
  recoverable_error: Type.Object({ sessionId: Type.Optional(SessionId), error: ContractError }),
  /** Fatal: the host is going away. The supervisor decides whether to restart. */
  fatal_error: Type.Object({ error: ContractError }),
})
