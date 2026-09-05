import { CONTRACT_VERSION, checkEnvelope, type HelloAck } from "@bake-pi/contract"
import { socketPort } from "../../../packages/agent-host/src/parent-port.ts"

const parent = await socketPort()

parent.on("message", (event) => {
  if (checkEnvelope("hello", event.data)) {
    parent.postMessage({
      kind: "hello_ack",
      contractVersion: CONTRACT_VERSION,
      piVersion: "wsl-handshake-fixture",
      nodeVersion: process.versions.node,
      processId: process.pid,
      features: {
        apiKeyPersistence: false,
        telemetryOptOut: false,
        policyHookOrdering: false,
        sessionFileLocking: false,
        processTreeCleanup: false,
        rpcFallback: false,
      },
    } satisfies HelloAck)
    return
  }

  if (isEventTicketRequest(event.data)) {
    const ticket = parent.createEventTicket((port) => {
      port.on("message", (message) => {
        if (!("data" in message) || !isEventAck(message.data)) return
        port.postMessage({
          kind: "event",
          name: "workspace_changed",
          sequence: 2,
          payload: {
            workspace: {
              id: "wsl-smoke",
              root: "/tmp/wsl-smoke",
              runtime: { kind: "wsl", distro: process.env.WSL_DISTRO_NAME ?? "unknown" },
              displayName: "wsl-smoke",
              trust: "untrusted",
              isGitRepository: false,
            },
          },
        })
      })
      port.start()
      port.postMessage({
        kind: "event",
        name: "host_ready",
        sequence: 1,
        payload: { piVersion: "wsl-handshake-fixture" },
      })
    })
    parent.postMessage({ kind: "event_ticket", id: event.data.id, ...ticket })
    return
  }

  if (checkEnvelope("command", event.data)) {
    const command = event.data as { id: string; name: string }
    if (command.name === "shutdown") {
      parent.postMessage({ kind: "response", id: command.id, ok: true, result: { accepted: true } })
      setImmediate(() => void parent.close().finally(() => process.exit(0)))
    }
  }
})

const isEventTicketRequest = (value: unknown): value is { kind: "event_ticket_request"; id: string } => {
  if (typeof value !== "object" || value === null) return false
  const request = value as { kind?: unknown; id?: unknown }
  return request.kind === "event_ticket_request" && typeof request.id === "string"
}

const isEventAck = (value: unknown): value is { kind: "event_ack"; count: number } => {
  if (typeof value !== "object" || value === null) return false
  const ack = value as { kind?: unknown; count?: unknown }
  return ack.kind === "event_ack" && ack.count === 1
}
