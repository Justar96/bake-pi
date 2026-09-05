import {
  CONTRACT_VERSION,
  type CommandName,
  type FeatureFlags,
  type Hello,
  type HelloAck,
  checkEnvelope,
  isCompatible,
} from "@bake-pi/contract"
import { Diagnostics } from "./diagnostics.ts"
import { createDispatcher } from "./dispatch.ts"
import { EventEmitter } from "./emitter.ts"
import { TimingStore } from "./observability/timings.ts"
import { type HostMessagePort, type ParentPort, type SocketParentPort, parentPort, socketPort } from "./parent-port.ts"
import { createPiRuntime } from "./runtime.ts"
import { announceQuarantine } from "./supervision.ts"
import type { HostServices } from "./services.ts"

const diagnostics = new Diagnostics()
const emitter = new EventEmitter()
let services: HostServices | undefined
let orphanStopStarted = false
const stopOrphanedSocketHost = (): void => {
  if (orphanStopStarted) return
  orphanStopStarted = true
  void (async () => {
    try {
      // Pi's public session disposal aborts active agents and their shell
      // process groups. Exiting directly here would strand a detached WSL tool
      // precisely when main is no longer alive to ask for a normal shutdown.
      await services?.shutdown({})
    } catch (error) {
      diagnostics.capture("socket.orphan.shutdown", error)
    } finally {
      process.exit(0)
    }
  })()
}
const parent = process.argv.includes("--listen")
  ? await socketPort({ onOrphaned: stopOrphanedSocketHost })
  : parentPort()

/**
 * Where this host's time went, owned here rather than by the Pi runtime.
 *
 * The runtime used to build it, which was the right home while every span was
 * something Pi did — a turn, a tool call, a handler. The command span is not:
 * it starts when a message arrives and stops when the answer is posted, and
 * both of those happen in this file, around a runtime that may not exist yet.
 * A store built by the runtime could not have measured the leg that refuses a
 * command because the runtime is missing, which is precisely the leg someone
 * asks about when the host is not answering.
 */
const timings = new TimingStore()

const dispatch = createDispatcher({
  diagnostics,
  emitter,
  timings,
  services: () => services,
  respond: (response) => parent.postMessage(response),
})

/**
 * When this module finished evaluating, in the host's own timeline.
 *
 * Main can time the fork, but from outside, forking a process and waiting for a
 * reply is one opaque interval — and it is the largest single leg of cold start.
 * Reporting this splits it: everything before is Electron launching a process
 * and Node bootstrapping, everything after is ours. Recorded at the bottom of
 * the module, because the point is to include this file's own imports, which is
 * where the agent host's bundle is evaluated.
 */
let moduleEvaluatedMs = 0

parent.on("message", (event) => {
  const message = event.data

  // The renderer's event port arrives as a transfer, not as a command.
  if (isEventPortMessage(message)) {
    const port = event.ports[0]
    if (port !== undefined) emitter.attach(port as HostMessagePort, message.restoreProjection === true)
    return
  }

  if (isEventTicketRequest(message) && isSocketParentPort(parent)) {
    const ticket = parent.createEventTicket((port) => emitter.attach(port, message.restoreProjection === true))
    parent.postMessage({ kind: "event_ticket", id: message.id, ...ticket })
    return
  }

  if (checkEnvelope("hello", message)) {
    void handshake(parent, message as Hello)
    return
  }

  // Not awaited, and not measured from here: the command span begins inside
  // `dispatch`, so what stays outside it is exactly the two checks above.
  if (isSocketParentPort(parent) && isRequestedShutdown(message)) {
    void dispatch(message).finally(() => {
      // `dispatch` has handed the response to ws. Give that frame one event-loop
      // turn to flush, then close the server so a graceful WSL stop does not
      // pay the two-second orphan grace intended for a vanished parent.
      setImmediate(() => void parent.close().finally(() => process.exit(0)))
    })
  } else {
    void dispatch(message)
  }
})

const handshake = async (port: ParentPort, hello: Hello): Promise<void> => {
  if (!isCompatible(hello.contractVersion)) {
    // Answer with the mismatch rather than staying silent, so the supervisor
    // reports a version problem instead of a handshake timeout.
    port.postMessage({
      kind: "hello_ack",
      contractVersion: CONTRACT_VERSION,
      piVersion: "unknown",
      nodeVersion: process.versions.node,
      features: UNKNOWN_FEATURES,
    } satisfies HelloAck)
    return
  }

  try {
    const beforeRuntime = performance.now()
    const runtime = await createPiRuntime({ diagnostics, emitter, timings })
    const runtimeMs = performance.now() - beforeRuntime
    services = runtime.services
    port.postMessage({
      kind: "hello_ack",
      contractVersion: CONTRACT_VERSION,
      piVersion: runtime.piVersion,
      nodeVersion: process.versions.node,
      processId: process.pid,
      features: runtime.features,
      // Durations, never timestamps: see `HostStartup` in the contract. Building
      // the Pi runtime is called out on its own because it is the one leg that
      // depends on a third party, and a regression there would otherwise arrive
      // as an unexplained handshake that got slower.
      startup: { moduleMs: moduleEvaluatedMs, runtimeMs, ackMs: performance.now() },
    } satisfies HelloAck)
    emitter.emit("host_ready", { piVersion: runtime.piVersion })

    announceQuarantine(emitter, hello.quarantinedSessions)
  } catch (error) {
    const contractError = diagnostics.capture("handshake", error)
    emitter.emit("fatal_error", { error: contractError })
    // Exit rather than sit in a half-initialized state answering commands with
    // "host_unavailable" forever. The supervisor's restart budget is the right
    // place to decide what happens next.
    process.exitCode = 1
    setTimeout(() => process.exit(1), 100)
  }
}

const isEventPortMessage = (message: unknown): message is { kind: "event_port"; restoreProjection?: boolean } =>
  typeof message === "object" && message !== null && (message as { kind?: unknown }).kind === "event_port"

const isEventTicketRequest = (
  message: unknown,
): message is { kind: "event_ticket_request"; id: string; restoreProjection?: boolean } => {
  if (typeof message !== "object" || message === null) return false
  const value = message as { kind?: unknown; id?: unknown; restoreProjection?: unknown }
  return value.kind === "event_ticket_request"
    && typeof value.id === "string"
    && value.id.length > 0
    && value.id.length <= 128
    && (value.restoreProjection === undefined || typeof value.restoreProjection === "boolean")
}

const isSocketParentPort = (port: ParentPort): port is SocketParentPort => "createEventTicket" in port

const isRequestedShutdown = (message: unknown): boolean => {
  if (!checkEnvelope("command", message)) return false
  const value = message as { kind?: unknown; name?: unknown; params?: unknown }
  return value.kind === "command"
    && value.name === "shutdown"
    && typeof value.params === "object"
    && value.params !== null
    && !Array.isArray(value.params)
    && Object.keys(value.params).length === 0
}

/**
 * What we report before we have measured anything. Every flag is false, because
 * a feature the renderer believes in and the host cannot deliver is worse than
 * one it never offered.
 */
const UNKNOWN_FEATURES: FeatureFlags = {
  apiKeyPersistence: false,
  telemetryOptOut: false,
  policyHookOrdering: false,
  sessionFileLocking: false,
  processTreeCleanup: false,
  rpcFallback: false,
}

// A rejection that reaches here is a bug in a handler that forgot to await.
// Recording it is the difference between a mysterious silence and a diagnostic.
process.on("unhandledRejection", (reason) => {
  diagnostics.capture("unhandledRejection", reason)
})

export type { CommandName }

moduleEvaluatedMs = performance.now()
