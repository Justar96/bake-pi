import type { TSchema } from "@sinclair/typebox"
import { Value } from "@sinclair/typebox/value"
import { CommandDefs, type CommandName, type CommandParams, type CommandResult, isCommandName } from "./commands/index.ts"
import { CommandEnvelope, EventEnvelope, MAX_ENVELOPE_BYTES, ResponseEnvelope } from "./envelope.ts"
import { BakePiError } from "./errors.ts"
import { EventDefs, type EventName, type EventPayload, isEventName } from "./events/index.ts"
import { Hello, HelloAck } from "./handshake.ts"
import { HostConnectionNotice } from "./dto/host.ts"

/**
 * Every check walks the schema. It used to compile: `TypeCompiler.Compile`
 * generates a closed-over function per schema, and the earlier version of this
 * comment argued that was what made validating every event on a hot streaming
 * path affordable.
 *
 * It cannot run where that path is. The compiler builds its validator with
 * `new globalThis.Function`, and the renderer's `script-src` carries no
 * `'unsafe-eval'`, so the constructor throws there. The renderer's intake
 * (`store/stream.ts`) is the only hot caller this module has — session events
 * arrive over a transferred `MessagePort`, straight into the main world, never
 * through main. Everything else here answers a command at human rates. A
 * compiled validator was therefore fast in exactly the one place it is illegal,
 * and free everywhere it was never needed.
 *
 * The cost of walking instead, measured on these schemas rather than assumed:
 * ~73 ns for a `block_delta` payload against ~5 ns compiled, ~132 ns for an
 * envelope against ~7 ns. So a full `acceptEvent` runs ~200 ns rather than
 * ~15 ns. The ratio the old comment claimed is real; its conclusion was not, at
 * this application's rates. Ten thousand events a second — far past anything a
 * model streams — costs two milliseconds of one core per second.
 *
 * If a measurement ever does demand compiled validators, the answer is
 * generating them at build time with `TypeCompiler.Code`, not compiling at
 * runtime. Reaching for `'unsafe-eval'` to buy back these nanoseconds would
 * hand every future injection foothold in the renderer a way to run code.
 */
const check = (schema: TSchema, value: unknown): boolean => Value.Check(schema, value)

const envelopeSchemas = {
  command: CommandEnvelope,
  response: ResponseEnvelope,
  event: EventEnvelope,
  hello: Hello,
  hello_ack: HelloAck,
}

export const checkEnvelope = (kind: keyof typeof envelopeSchemas, value: unknown): boolean =>
  check(envelopeSchemas[kind], value)

/**
 * Rough size guard applied before validation. The utility-process channel gives
 * us no byte count, while the socket channel has already decoded its bounded
 * frame, so both estimate from the JSON length here. That is an over-estimate
 * for binary and an under-estimate for nothing; erring here refuses too early
 * rather than too late.
 */
export const exceedsSizeLimit = (value: unknown, limit = MAX_ENVELOPE_BYTES): boolean => {
  try {
    return JSON.stringify(value)!.length > limit
  } catch {
    // Cyclic or non-serializable values can arrive only through structured
    // clone, but nothing in the contract is shaped that way, so refuse them.
    return true
  }
}

export const parseCommandParams = <N extends CommandName>(name: N, params: unknown): CommandParams<N> => {
  if (!check(CommandDefs[name].params, params)) {
    throw new BakePiError("malformed_command", { detail: name })
  }
  return params as CommandParams<N>
}

export const parseCommandResult = <N extends CommandName>(name: N, result: unknown): CommandResult<N> => {
  if (!check(CommandDefs[name].result, result)) {
    throw new BakePiError("internal_error", { detail: `${name}:result` })
  }
  return result as CommandResult<N>
}

export const parseEventPayload = <N extends EventName>(name: N, payload: unknown): EventPayload<N> => {
  if (!check(EventDefs[name], payload)) {
    throw new BakePiError("internal_error", { detail: `${name}:event` })
  }
  return payload as EventPayload<N>
}

export const parseHostConnectionNotice = (value: unknown): HostConnectionNotice => {
  if (!check(HostConnectionNotice, value)) {
    throw new BakePiError("internal_error", { detail: "host_connection_notice" })
  }
  return value as HostConnectionNotice
}

/**
 * The one entry point a receiving side should use for an inbound command: it
 * checks the envelope, the name, the size, and the params, and throws a
 * structured error for each distinct failure. Callers that skip a step here are
 * the reason unvalidated input reaches a tool.
 */
export const acceptCommand = (
  value: unknown,
): { id: string; name: CommandName; params: unknown } => {
  if (exceedsSizeLimit(value)) throw new BakePiError("payload_too_large")
  if (!checkEnvelope("command", value)) throw new BakePiError("malformed_command")
  const envelope = value as CommandEnvelope
  if (!isCommandName(envelope.name)) {
    throw new BakePiError("unknown_command", { detail: envelope.name })
  }
  return { id: envelope.id, name: envelope.name, params: parseCommandParams(envelope.name, envelope.params) }
}

export const acceptEvent = (value: unknown): { name: EventName; sequence: number; sessionId?: string; payload: unknown } => {
  if (!checkEnvelope("event", value)) throw new BakePiError("internal_error", { detail: "event_envelope" })
  const envelope = value as EventEnvelope
  if (!isEventName(envelope.name)) throw new BakePiError("internal_error", { detail: envelope.name })
  return {
    name: envelope.name,
    sequence: envelope.sequence,
    ...(envelope.sessionId === undefined ? {} : { sessionId: envelope.sessionId }),
    payload: parseEventPayload(envelope.name, envelope.payload),
  }
}
