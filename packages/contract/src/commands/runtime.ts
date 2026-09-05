import { Type } from "@sinclair/typebox"
import { ContractError } from "../errors.ts"
import { SessionId } from "../dto/primitives.ts"
import { defineCommands } from "./define.ts"

export const RuntimeInfo = Type.Object({
  appVersion: Type.String({ maxLength: 64 }),
  piVersion: Type.String({ maxLength: 64 }),
  /** Present only when the non-blocking update check found a newer Pi release. */
  latestPiVersion: Type.Optional(Type.String({ maxLength: 64 })),
  electronVersion: Type.String({ maxLength: 64 }),
  nodeVersion: Type.String({ maxLength: 64 }),
  platform: Type.String({ maxLength: 32 }),
  arch: Type.String({ maxLength: 32 }),
})

export const DiagnosticEntry = Type.Object({
  id: Type.String({ maxLength: 64 }),
  at: Type.Integer({ minimum: 0 }),
  level: Type.Union([Type.Literal("info"), Type.Literal("warn"), Type.Literal("error")]),
  scope: Type.String({ maxLength: 64 }),
  message: Type.String({ maxLength: 4096 }),
  error: Type.Optional(ContractError),
})

export const runtimeCommands = defineCommands({
  get_runtime_info: { params: Type.Object({}), result: RuntimeInfo },
  get_diagnostics: {
    params: Type.Object({ sinceId: Type.Optional(Type.String({ maxLength: 64 })), limit: Type.Integer({ minimum: 1, maximum: 1000 }) }),
    result: Type.Object({ entries: Type.Array(DiagnosticEntry) }),
  },
  /** Requests an orderly shutdown. The host acknowledges, then stops accepting commands. */
  shutdown: { params: Type.Object({}), result: Type.Object({ accepted: Type.Boolean() }) },
  /**
   * Restarts the agent host after the supervisor declined to do it on its own.
   *
   * The supervisor stops restarting in two cases: the budget is spent, or the
   * crash interrupted something whose outcome cannot be described. Both leave a
   * window with no host behind it, and this is how a person gets out of that
   * without relaunching the application.
   *
   * Answered by main, not by the agent host — see `MAIN_OWNED_COMMANDS`. It is
   * the one command whose whole purpose is to be answerable while no host
   * exists.
   */
  restart_host: {
    params: Type.Object({}),
    result: Type.Object({
      started: Type.Boolean(),
      /** Sessions the supervisor will not reopen, so the caller can say which are gone. */
      quarantined: Type.Array(SessionId),
    }),
  },
})
