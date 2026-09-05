import {
  BakePiError,
  acceptCommand,
  isMainOwnedCommand,
  type ResponseEnvelope,
} from "@bake-pi/contract"
import type { Diagnostics } from "./diagnostics.ts"
import type { EventEmitter } from "./emitter.ts"
import type { TimingStore } from "./observability/timings.ts"
import type { HostServices } from "./services.ts"

/**
 * The host's whole leg of a command: a message off the parent channel to a
 * response posted back.
 *
 * This lived inside `index.ts` until the command span had to cover it. The two
 * are separable for a reason that is not tidiness: `index.ts` is the adapter to
 * the one environment this package cannot have in a test — Electron's
 * real parent channel, which `parent-port.ts` acquires from Electron or opens
 * on loopback — while
 * everything a command's latency is made of is ordinary code with ordinary
 * dependencies. Keeping them in one file meant the only way to observe the leg
 * was to run the real application, and a leg nobody can observe in a test is a
 * leg whose instrument nobody can check.
 */
export type Dispatch = (message: unknown) => Promise<void>

export const createDispatcher = (deps: {
  diagnostics: Diagnostics
  emitter: EventEmitter
  timings: TimingStore
  /**
   * The handler map, read through a function rather than held, because it does
   * not exist yet when this is built. The host answers commands from the moment
   * it can receive one, and the runtime that answers them is built during the
   * handshake — so a command can arrive before there is anything to run it, and
   * `host_unavailable` is that answer. Reading the slot per command is what
   * makes the window between the two a refusal rather than a crash.
   */
  services: () => HostServices | undefined
  /** Posts a response. Separate from the port so the leg can be driven without one. */
  respond: (response: ResponseEnvelope) => void
}): Dispatch => {
  const { diagnostics, emitter, timings, services, respond } = deps

  let shuttingDown = false

  /**
   * The key that pairs this command's `beginCommand` with its `endCommand`.
   *
   * A counter rather than the command's own request id, and the reason is the
   * same one that made the previous instrument use a counter: the store takes a
   * key only to pair a begin with an end and never records it, and an id the
   * renderer minted is exactly the kind of value that should not be within
   * reach of a report that reaches the renderer. It is also the only key
   * available before validation, which is where the span now starts — the id
   * on an unvalidated envelope is an arbitrary string, and using it would put
   * one in the store's open map.
   */
  let sequence = 0

  return async (message: unknown): Promise<void> => {
    /*
     * The clock starts here, before anything has looked at the message, and it
     * stops after the response has been handed to the port. That is the host's
     * whole leg, and it is deliberately more than the handler: the size guard's
     * `JSON.stringify`, the envelope and params validation inside
     * `acceptCommand`, the shutdown gate, the availability check, the
     * main-owned check and the handler lookup all fall inside it. They are real
     * host work — an eight-megabyte or malformed payload is refused by exactly
     * that stretch and by no handler at all — and an instrument that started
     * after them would report the cheap part of a slow command and leave the
     * expensive part in a residual named after something else.
     *
     * **What main's round trip minus this figure now equals.** `RecoveryLedger`
     * in main times two legs: `main`, from arrival in the IPC handler to the
     * command leaving for the host, and `roundTrip`, from the command leaving
     * to the answer being in hand. `roundTrip` minus this span is:
     *
     *   - the parent-channel hop each way, including JSON framing for a socket
     *     host and whatever queueing either side's event loop did before
     *     delivering;
     *   - the host's per-message triage in `index.ts` — the `event_port`
     *     property read and the `hello` envelope check — which run on the
     *     command path before this function is called;
     *   - main's own work receiving the response and settling the promise the
     *     caller is waiting on, which its clock is still running for.
     *
     * It is not "transport plus the host's dispatch" any more, which is what it
     * was when the span wrapped the handler map. It is transport, queueing, and
     * two schema-level checks whose cost is bounded by the message's size.
     *
     * That subtraction is two durations, each measured inside one process on
     * that process's own clock, and never two instants — the one arithmetic
     * Milestone 2.1 forbids. Neither number is a timestamp and neither travels.
     *
     * **Where the boundary falls at the end**, since the honest answer decides
     * what the residual contains. `respond` runs inside the `try`/`catch` and
     * `endCommand` runs in the `finally` after it, so the `postMessage` call is
     * inside the span — that call structured-clones on the utility-process
     * channel and JSON-serialises on the socket channel, so building and
     * serialising a reply is charged to the host that produced it. A 200 KB
     * `get_timings` report is the case that makes this matter, and charging it
     * to transport would blame the wire for the host's own work. What is outside
     * is everything after that call returns: delivery, and main's end of the
     * hop.
     *
     * One span per command, opened once here. The previous instrument wrapped
     * every entry in the `HostServices` map, and wrapping the map is what this
     * replaces rather than what it adds to — two spans for one command would
     * make `count` a count of instruments rather than of commands. Nothing is
     * lost with the wrapper: it recorded in a `finally` so a throwing handler
     * was still measured, which this does; it keyed on a counter, which this
     * does; and it was derived from the map's own keys so that a new command
     * was timed the moment its handler existed, which this improves on — a
     * command is timed here before the host knows which command it is, so a
     * handler cannot be added without being timed and a command with no handler
     * at all is timed too.
     *
     * `prompt` remains the handler worth understanding: it returns as soon as
     * the run is accepted rather than awaiting the turn, so `command.prompt` is
     * the cost of accepting a prompt and the turn spans are the cost of
     * answering it. Two questions, two spans.
     */
    const key = String((sequence += 1))
    timings.beginCommand(key)

    let id = "unknown"
    try {
      const command = acceptCommand(message)
      id = command.id
      // The span has been running since before the envelope was looked at; this
      // is the first moment it can be told what it is measuring.
      timings.nameCommand(key, command.name)

      // Two commands survive the shutdown gate, and both for the same reason: a
      // shutdown that is going badly is exactly when someone needs to know why.
      // Refusing to report during the interval under investigation would make the
      // slow case the one case with no evidence.
      if (shuttingDown && command.name !== "get_diagnostics" && command.name !== "get_timings") {
        throw new BakePiError("host_shutting_down", { retryable: true })
      }
      const handlers = services()
      if (handlers === undefined) throw new BakePiError("host_unavailable", { retryable: true })

      if (command.name === "shutdown") {
        shuttingDown = true
        emitter.emit("host_shutting_down", { reason: "requested" })
      }

      if (isMainOwnedCommand(command.name)) {
        // Main answers this one and never forwards it. Reaching here means the
        // router is broken, and answering anything at all would hide that: this
        // process cannot restart itself, so a plausible reply would be a lie.
        throw new BakePiError("internal_error", { detail: `main_owned:${command.name}` })
      }

      const handler = handlers[command.name] as (params: unknown) => Promise<unknown>
      respond({ kind: "response", id, ok: true, result: await handler(command.params) })
    } catch (error) {
      respond({ kind: "response", id, ok: false, error: diagnostics.capture(scopeOf(message), error) })
    } finally {
      // Every exit is this one. A refusal is a leg the host spent time on, and
      // a command that fails slowly is the command worth seeing.
      timings.endCommand(key)
    }
  }
}

/**
 * What a diagnostic entry for this failure is filed under.
 *
 * Reads the name off the raw message rather than off a validated command,
 * because the failures worth attributing are the ones that happen before there
 * is a validated command. It is a diagnostic scope and not a span name: the
 * diagnostics log stays in the host and is read through `get_diagnostics`,
 * while a span name reaches the renderer and is drawn from a closed vocabulary
 * for exactly that reason.
 */
const scopeOf = (message: unknown): string => {
  const name = (message as { name?: unknown } | null)?.name
  return typeof name === "string" ? `command.${name}` : "command"
}
