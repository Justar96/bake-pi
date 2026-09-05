import { MAX_ENVELOPE_BYTES, checkEnvelope, type Hello } from "@bake-pi/contract"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { WebSocketServer, WebSocket, type RawData } from "ws"

/**
 * The agent host runs either inside an Electron `utilityProcess` or as a plain
 * Node process reached over loopback, but it must not depend on `electron`.
 * That boundary is what keeps this package buildable and testable as a plain
 * Node module, and `boundaries.test.ts` enforces it.
 *
 * The two port shapes below are therefore the host's vocabulary rather than
 * Electron's. Both the utility-process parent channel and the loopback socket
 * adapt to them; the runtime above this file does not know which one it has.
 */
export interface HostMessagePort {
  postMessage(message: unknown): void
  on(event: "message" | "close", listener: ((event: { data: unknown }) => void) | (() => void)): void
  start(): void
  close(): void
}

export interface ParentPort {
  postMessage(message: unknown): void
  on(event: "message", listener: (event: { data: unknown; ports: HostMessagePort[] }) => void): void
}

export interface SocketParentPort extends ParentPort {
  createEventTicket(accept: (port: HostMessagePort) => void): EventSocketTicket
  close(): Promise<void>
}

export interface EventSocketTicket {
  port: number
  ticket: string
}

export interface SocketPortOptions {
  announce?: (address: { port: number; token: string }) => void
  disconnectGraceMs?: number
  onOrphaned?: () => void
}

export const parentPort = (): ParentPort => {
  const port = (process as unknown as { parentPort?: ParentPort }).parentPort
  if (port === undefined) {
    throw new Error("agent host must run inside an Electron utilityProcess; no parentPort was found")
  }
  return port
}

/**
 * Opens the authenticated loopback parent channel used by a host inside WSL.
 *
 * The random token is printed once beside the ephemeral port and must be on
 * the first frame. It is transport authentication, not contract data, so the
 * adapter removes it before handing the ordinary `hello` envelope to the host.
 * Every frame after that is JSON carrying the same envelopes as the Electron
 * channel.
 */
export const socketPort = async (options: SocketPortOptions = {}): Promise<SocketParentPort> => {
  const token = randomBytes(32).toString("hex")
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    maxPayload: MAX_ENVELOPE_BYTES,
    perMessageDeflate: false,
  })
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
  })

  const address = server.address()
  if (address === null || typeof address === "string") {
    await closeServer(server)
    throw new Error("loopback WebSocket server did not report a TCP address")
  }

  const port = new LoopbackParentPort(server, address.port, token, options)
  ;(options.announce ?? announceSocket)({ port: address.port, token })
  return port
}

class LoopbackParentPort implements SocketParentPort {
  readonly #server: WebSocketServer
  readonly #port: number
  readonly #token: string
  readonly #disconnectGraceMs: number
  readonly #onOrphaned: () => void
  readonly #listeners = new Set<(event: { data: unknown; ports: HostMessagePort[] }) => void>()
  readonly #pending: { data: unknown; ports: HostMessagePort[] }[] = []
  readonly #eventTickets = new Map<string, {
    accept: (port: HostMessagePort) => void
    timer: NodeJS.Timeout
  }>()
  #owner: WebSocket | undefined
  #disconnectTimer: NodeJS.Timeout | undefined
  #closed = false

  constructor(server: WebSocketServer, port: number, token: string, options: SocketPortOptions) {
    this.#server = server
    this.#port = port
    this.#token = token
    this.#disconnectGraceMs = options.disconnectGraceMs ?? 2_000
    this.#onOrphaned = options.onOrphaned ?? (() => process.exit(0))
    server.on("connection", (socket, request) => this.#accept(socket, request.url))
    this.#scheduleOrphaned()
  }

  postMessage(message: unknown): void {
    const owner = this.#owner
    if (owner === undefined || owner.readyState !== WebSocket.OPEN) {
      throw new Error("loopback parent socket is not connected")
    }
    owner.send(JSON.stringify(message))
  }

  on(event: "message", listener: (event: { data: unknown; ports: HostMessagePort[] }) => void): void {
    if (event !== "message") return
    this.#listeners.add(listener)
    for (const pending of this.#pending.splice(0)) listener(pending)
  }

  createEventTicket(accept: (port: HostMessagePort) => void): EventSocketTicket {
    if (this.#closed) throw new Error("loopback parent socket is closed")
    const ticket = randomBytes(32).toString("hex")
    const timer = setTimeout(() => this.#eventTickets.delete(ticket), 15_000)
    timer.unref()
    this.#eventTickets.set(ticket, { accept, timer })
    return { port: this.#port, ticket }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    if (this.#disconnectTimer !== undefined) clearTimeout(this.#disconnectTimer)
    this.#disconnectTimer = undefined
    for (const pending of this.#eventTickets.values()) clearTimeout(pending.timer)
    this.#eventTickets.clear()
    this.#owner?.close(1001, "host closing")
    this.#owner = undefined
    await closeServer(this.#server)
  }

  #accept(socket: WebSocket, path: string | undefined): void {
    const ticket = /^\/events\?ticket=([a-f0-9]{64})$/u.exec(path ?? "")?.[1]
    if (ticket === undefined) {
      if (path?.startsWith("/events") === true) {
        socket.close(1008, "invalid event ticket")
        return
      }
      this.#authenticate(socket)
      return
    }

    const pending = this.#eventTickets.get(ticket)
    if (pending === undefined) {
      socket.close(1008, "invalid event ticket")
      return
    }
    this.#eventTickets.delete(ticket)
    clearTimeout(pending.timer)
    pending.accept(new WebSocketMessagePort(socket))
  }

  #authenticate(socket: WebSocket): void {
    const authTimer = setTimeout(() => socket.close(1008, "hello required"), 5_000)
    authTimer.unref()
    socket.once("message", (data, isBinary) => {
      clearTimeout(authTimer)
      const hello = isBinary ? undefined : authenticateHello(data, this.#token)
      if (hello === undefined) {
        socket.close(1008, "invalid hello")
        return
      }
      if (this.#owner !== undefined) {
        socket.close(1013, "host already connected")
        return
      }

      if (this.#disconnectTimer !== undefined) clearTimeout(this.#disconnectTimer)
      this.#disconnectTimer = undefined
      this.#owner = socket
      socket.on("message", (next, binary) => {
        if (binary) {
          socket.close(1003, "text frames required")
          return
        }
        const message = parseJson(next)
        if (message === undefined) {
          socket.close(1007, "invalid JSON")
          return
        }
        this.#emit(message)
      })
      socket.once("close", () => this.#ownerClosed(socket))
      this.#emit(hello)
    })
  }

  #emit(data: unknown): void {
    const event = { data, ports: [] }
    if (this.#listeners.size === 0) {
      this.#pending.push(event)
      return
    }
    for (const listener of this.#listeners) listener(event)
  }

  #ownerClosed(socket: WebSocket): void {
    if (this.#owner !== socket || this.#closed) return
    this.#owner = undefined
    this.#scheduleOrphaned()
  }

  #scheduleOrphaned(): void {
    if (this.#disconnectTimer !== undefined) clearTimeout(this.#disconnectTimer)
    this.#disconnectTimer = setTimeout(() => {
      this.#disconnectTimer = undefined
      if (this.#owner === undefined && !this.#closed) this.#onOrphaned()
    }, this.#disconnectGraceMs)
    this.#disconnectTimer.unref()
  }
}

class WebSocketMessagePort implements HostMessagePort {
  readonly #socket: WebSocket

  constructor(socket: WebSocket) {
    this.#socket = socket
  }

  postMessage(message: unknown): void {
    if (this.#socket.readyState !== WebSocket.OPEN) throw new Error("event socket is not connected")
    this.#socket.send(JSON.stringify(message))
  }

  on(event: "message" | "close", listener: ((event: { data: unknown }) => void) | (() => void)): void {
    if (event === "close") {
      this.#socket.on("close", listener as () => void)
      return
    }
    this.#socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.#socket.close(1003, "text frames required")
        return
      }
      const message = parseJson(data)
      if (message === undefined) {
        this.#socket.close(1007, "invalid JSON")
        return
      }
      ;(listener as (event: { data: unknown }) => void)({ data: message })
    })
  }

  start(): void {}

  close(): void {
    this.#socket.close(1000, "event port replaced")
  }
}

const authenticateHello = (data: RawData, expectedToken: string): Hello | undefined => {
  const frame = parseJson(data)
  if (typeof frame !== "object" || frame === null) return undefined
  const { token, ...hello } = frame as Record<string, unknown>
  if (typeof token !== "string" || !sameToken(token, expectedToken)) return undefined
  return checkEnvelope("hello", hello) ? hello as Hello : undefined
}

const sameToken = (actual: string, expected: string): boolean => {
  const actualBytes = Buffer.from(actual, "utf8")
  const expectedBytes = Buffer.from(expected, "utf8")
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

const parseJson = (data: RawData): unknown | undefined => {
  try {
    const bytes = Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(new Uint8Array(data))
    return JSON.parse(bytes.toString("utf8"))
  } catch {
    return undefined
  }
}

const announceSocket = (address: { port: number; token: string }): void => {
  process.stdout.write(`${JSON.stringify(address)}\n`)
}

const closeServer = async (server: WebSocketServer): Promise<void> => {
  for (const client of server.clients) client.terminate()
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error))
  })
}
