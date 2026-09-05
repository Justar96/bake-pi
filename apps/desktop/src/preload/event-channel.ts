export interface EventSocketDescriptor {
  kind: "websocket"
  url: string
}

export interface EventSocketBridge {
  port: MessagePort
  opened: Promise<void>
  close(): void
}

/** Accepts only the loopback URL shape minted by the WSL launcher. */
export const parseEventSocketDescriptor = (raw: unknown): EventSocketDescriptor | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined
  const value = raw as { kind?: unknown; url?: unknown }
  if (value.kind !== "websocket" || typeof value.url !== "string") return undefined
  const match = /^ws:\/\/127\.0\.0\.1:(\d{1,5})\/events\?ticket=[a-f0-9]{64}$/u.exec(value.url)
  const port = Number(match?.[1])
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined
  return { kind: "websocket", url: value.url }
}

/**
 * Adapts a JSON WebSocket to the MessagePort shape already consumed by the
 * renderer. The ticket URL stays in preload's isolated world; the page sees
 * only its end of this local channel and EventStream remains transport-blind.
 */
export const createEventSocketBridge = (url: string): EventSocketBridge => {
  const socket = new WebSocket(url)
  const channel = new MessageChannel()
  let settled = false
  let resolveOpened!: () => void
  let rejectOpened!: (error: Error) => void
  const opened = new Promise<void>((resolve, reject) => {
    resolveOpened = resolve
    rejectOpened = reject
  })

  socket.addEventListener("open", () => {
    settled = true
    resolveOpened()
  }, { once: true })
  socket.addEventListener("error", () => {
    if (settled) return
    settled = true
    rejectOpened(new Error("event socket could not connect"))
  }, { once: true })
  socket.addEventListener("close", () => {
    channel.port1.close()
    if (settled) return
    settled = true
    rejectOpened(new Error("event socket closed before connecting"))
  }, { once: true })
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      socket.close(1003, "text frames required")
      return
    }
    try {
      channel.port1.postMessage(JSON.parse(event.data))
    } catch {
      socket.close(1007, "invalid JSON")
    }
  })
  channel.port1.onmessage = (event) => {
    if (socket.readyState !== WebSocket.OPEN) return
    try {
      socket.send(JSON.stringify(event.data))
    } catch {
      socket.close(1007, "invalid JSON")
    }
  }
  channel.port1.start()

  return {
    port: channel.port2,
    opened,
    close: () => {
      channel.port1.close()
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
        socket.close(1000, "event channel replaced")
      }
    },
  }
}
