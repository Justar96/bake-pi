import { describe, expect, test } from "bun:test"
import { CONTRACT_VERSION, type Hello, type HelloAck } from "@bake-pi/contract"
import { once } from "node:events"
import WebSocket, { type RawData } from "ws"
import { socketPort, type HostMessagePort } from "./parent-port.ts"

const hello: Hello = {
  kind: "hello",
  contractVersion: CONTRACT_VERSION,
  appVersion: "test",
  platform: "win32",
  arch: "x64",
}

const ack: HelloAck = {
  kind: "hello_ack",
  contractVersion: CONTRACT_VERSION,
  piVersion: "test",
  nodeVersion: process.versions.node,
  features: {
    apiKeyPersistence: false,
    telemetryOptOut: false,
    policyHookOrdering: false,
    sessionFileLocking: false,
    processTreeCleanup: false,
    rpcFallback: false,
  },
}

const connect = async (port: number): Promise<WebSocket> => {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}`)
  await once(socket, "open")
  return socket
}

const receive = async (socket: WebSocket): Promise<unknown> => {
  const [data] = await once(socket, "message") as [RawData]
  return JSON.parse(Buffer.from(data as Buffer).toString("utf8"))
}

describe("loopback parent port", () => {
  test("requires the token on a valid hello and removes it before delivery", async () => {
    let address!: { port: number; token: string }
    const parent = await socketPort({ announce: (value) => { address = value } })
    const received: unknown[] = []
    let receivedHello!: () => void
    const helloDelivered = new Promise<void>((resolve) => { receivedHello = resolve })
    parent.on("message", (event) => {
      received.push(event.data)
      receivedHello()
    })

    try {
      const rejected = await connect(address.port)
      rejected.send(JSON.stringify({ ...hello, token: "wrong" }))
      const [code] = await once(rejected, "close")
      expect(code).toBe(1008)
      expect(received).toEqual([])

      const accepted = await connect(address.port)
      accepted.send(JSON.stringify({ ...hello, token: address.token }))
      await helloDelivered
      expect(received).toEqual([hello])

      const response = receive(accepted)
      parent.postMessage(ack)
      expect(await response).toEqual(ack)
      accepted.close()
      await once(accepted, "close")
    } finally {
      await parent.close()
    }
  })

  test("closes malformed frames and exits after the owner disconnect grace", async () => {
    let address!: { port: number; token: string }
    let orphaned!: () => void
    const orphan = new Promise<void>((resolve) => { orphaned = resolve })
    const parent = await socketPort({
      announce: (value) => { address = value },
      disconnectGraceMs: 0,
      onOrphaned: () => orphaned(),
    })
    let receivedHello!: () => void
    const helloDelivered = new Promise<void>((resolve) => { receivedHello = resolve })
    parent.on("message", () => receivedHello())

    try {
      const socket = await connect(address.port)
      socket.send(JSON.stringify({ ...hello, token: address.token }))
      await helloDelivered
      socket.send("not-json")
      const [code] = await once(socket, "close")
      expect(code).toBe(1007)
      await orphan
    } finally {
      await parent.close()
    }
  })

  test("mints a one-time event socket that carries events and acknowledgements", async () => {
    let address!: { port: number; token: string }
    const parent = await socketPort({ announce: (value) => { address = value } })
    let acceptEventPort!: (port: HostMessagePort) => void
    const accepted = new Promise<HostMessagePort>((resolve) => { acceptEventPort = resolve })
    const ticket = parent.createEventTicket(acceptEventPort)

    try {
      expect(ticket.port).toBe(address.port)
      const malformed = new WebSocket(`ws://127.0.0.1:${String(ticket.port)}/events?ticket=short`)
      await once(malformed, "open")
      const [malformedCode] = await once(malformed, "close")
      expect(malformedCode).toBe(1008)

      const socket = new WebSocket(
        `ws://127.0.0.1:${String(ticket.port)}/events?ticket=${ticket.ticket}`,
      )
      await once(socket, "open")
      const eventPort = await accepted

      const event = receive(socket)
      eventPort.postMessage({ kind: "event", sequence: 1 })
      expect(await event).toEqual({ kind: "event", sequence: 1 })

      const acknowledgement = new Promise<unknown>((resolve) => {
        eventPort.on("message", (message) => resolve("data" in message ? message.data : undefined))
      })
      socket.send(JSON.stringify({ kind: "event_ack", count: 1 }))
      expect(await acknowledgement).toEqual({ kind: "event_ack", count: 1 })

      const reused = new WebSocket(
        `ws://127.0.0.1:${String(ticket.port)}/events?ticket=${ticket.ticket}`,
      )
      await once(reused, "open")
      const [code] = await once(reused, "close")
      expect(code).toBe(1008)

      socket.close()
      await once(socket, "close")
    } finally {
      await parent.close()
    }
  })
})
