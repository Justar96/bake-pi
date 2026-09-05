import { describe, expect, test } from "bun:test"
import { parseEventSocketDescriptor } from "./event-channel.ts"

describe("preload event socket descriptor", () => {
  test("accepts only a ticketed IPv4 loopback event URL", () => {
    const ticket = "ef".repeat(32)
    const descriptor = { kind: "websocket", url: `ws://127.0.0.1:43_210/events?ticket=${ticket}` }
    expect(parseEventSocketDescriptor(descriptor)).toBeUndefined()

    const valid = { kind: "websocket", url: `ws://127.0.0.1:43210/events?ticket=${ticket}` } as const
    expect(parseEventSocketDescriptor(valid)).toEqual(valid)
    expect(parseEventSocketDescriptor({ ...valid, url: valid.url + "&extra=true" })).toBeUndefined()
    expect(parseEventSocketDescriptor({ ...valid, url: valid.url.replace("127.0.0.1", "localhost") })).toBeUndefined()
    expect(parseEventSocketDescriptor({ ...valid, url: valid.url.replace("ws:", "wss:") })).toBeUndefined()
    expect(parseEventSocketDescriptor({ kind: "message_port", url: valid.url })).toBeUndefined()
  })
})
