import { describe, expect, test } from "bun:test"
import { parseEventTicket, parseSocketAnnouncement } from "./wsl-launcher.ts"

describe("WSL launcher inputs", () => {
  test("accepts only an ephemeral TCP address with a 32-byte token", () => {
    const token = "ab".repeat(32)
    expect(parseSocketAnnouncement(JSON.stringify({ port: 43_210, token }))).toEqual({ port: 43_210, token })
    expect(parseSocketAnnouncement(JSON.stringify({ port: 0, token }))).toBeUndefined()
    expect(parseSocketAnnouncement(JSON.stringify({ port: 43_210, token: "short" }))).toBeUndefined()
    expect(parseSocketAnnouncement("not-json")).toBeUndefined()
  })

  test("accepts only a bounded one-time event ticket response", () => {
    const ticket = "cd".repeat(32)
    expect(parseEventTicket({ kind: "event_ticket", id: "request", port: 43_210, ticket })).toEqual({
      kind: "event_ticket",
      id: "request",
      port: 43_210,
      ticket,
    })
    expect(parseEventTicket({ kind: "event_ticket", id: "request", port: 0, ticket })).toBeUndefined()
    expect(parseEventTicket({ kind: "event_ticket", id: "request", port: 43_210, ticket: "short" })).toBeUndefined()
    expect(parseEventTicket({ kind: "event_ticket", id: "", port: 43_210, ticket })).toBeUndefined()
  })
})
