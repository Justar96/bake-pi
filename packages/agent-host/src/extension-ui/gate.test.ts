import { describe, expect, test } from "bun:test"
import { acceptEvent, type EventEnvelope, type EventPayload, type ExtensionUiRequest } from "@bake-pi/contract"
import { EventEmitter } from "../emitter.ts"
import type { HostMessagePort } from "../parent-port.ts"
import { ExtensionUiGate } from "./gate.ts"

const harness = (): { gate: ExtensionUiGate; events: EventEnvelope[] } => {
  const events: EventEnvelope[] = []
  const emitter = new EventEmitter()
  emitter.attach({
    postMessage: (message: unknown) => {
      const event = message as EventEnvelope
      acceptEvent(event)
      events.push(event)
    },
    on: () => {},
    start: () => {},
    close: () => {},
  } satisfies HostMessagePort)
  return { gate: new ExtensionUiGate(emitter), events }
}

const lastRequest = (events: readonly EventEnvelope[]): ExtensionUiRequest =>
  (
    [...events].reverse().find((event) => event.name === "extension_ui_requested")!
      .payload as EventPayload<"extension_ui_requested">
  ).request

describe("extension dialogs", () => {
  test("each portable Pi dialog round-trips through its matching response command", async () => {
    const { gate, events } = harness()
    const ui = gate.contextFor("session-1")

    const selecting = ui.select("Choose", ["One", "Two"])
    const select = lastRequest(events)
    expect(select).toMatchObject({
      sessionId: "session-1",
      kind: "select",
      title: "Choose",
      options: [
        { value: "One", label: "One" },
        { value: "Two", label: "Two" },
      ],
    })
    expect(gate.respondSelect(select.id, "Two")).toBe(true)
    expect(await selecting).toBe("Two")

    const confirming = ui.confirm("Continue?", "This changes the session")
    const confirm = lastRequest(events)
    expect(confirm).toMatchObject({ kind: "confirm", message: "This changes the session" })
    expect(gate.respondConfirm(confirm.id, true)).toBe(true)
    expect(await confirming).toBe(true)

    const inputting = ui.input("Name", "optional")
    const input = lastRequest(events)
    expect(input).toMatchObject({ kind: "input", placeholder: "optional", secret: false })
    expect(gate.respondInput(input.id, "Bake Pi")).toBe(true)
    expect(await inputting).toBe("Bake Pi")

    const editing = ui.editor("Edit", "first line")
    const editor = lastRequest(events)
    expect(editor).toMatchObject({ kind: "editor", initialText: "first line" })
    expect(gate.respondEditor(editor.id, "changed")).toBe(true)
    expect(await editing).toBe("changed")

    expect(events.filter((event) => event.name === "extension_ui_requested")).toHaveLength(4)
    expect(events.filter((event) => event.name === "extension_ui_resolved")).toHaveLength(4)
  })

  test("a stale, wrong-kind, or unoffered response cannot settle a request", async () => {
    const { gate, events } = harness()
    const selecting = gate.contextFor("session-1").select("Choose", ["One"])
    const request = lastRequest(events)

    expect(gate.respondInput(request.id, "injected")).toBe(false)
    expect(gate.respondSelect(request.id, "not offered")).toBe(false)
    expect(gate.respondSelect("missing", "One")).toBe(false)
    expect(events.filter((event) => event.name === "extension_ui_resolved")).toHaveLength(0)

    expect(gate.respondSelect(request.id, null)).toBe(true)
    expect(await selecting).toBeUndefined()
    expect(gate.respondSelect(request.id, "One")).toBe(false)
  })

  test("session close and host shutdown return safe defaults without crossing sessions", async () => {
    const { gate, events } = harness()
    const first = gate.contextFor("session-1").confirm("First", "")
    const firstRequest = lastRequest(events)
    const second = gate.contextFor("session-2").input("Second")
    const secondRequest = lastRequest(events)

    gate.cancelSession("session-1")
    expect(await first).toBe(false)
    expect(gate.respondConfirm(firstRequest.id, true)).toBe(false)
    expect(gate.respondInput(secondRequest.id, "still waiting")).toBe(true)
    expect(await second).toBe("still waiting")

    const third = gate.contextFor("session-3").editor("Third")
    gate.cancelAll()
    expect(await third).toBeUndefined()
  })

  test("abort and timeout dismiss a dialog, including an already-aborted signal", async () => {
    const { gate, events } = harness()
    const ui = gate.contextFor("session-1")

    const controller = new AbortController()
    const input = ui.input("Input", undefined, { signal: controller.signal })
    const inputRequest = lastRequest(events)
    controller.abort()
    expect(await input).toBeUndefined()
    expect(gate.respondInput(inputRequest.id, "late")).toBe(false)

    const confirmation = ui.confirm("Confirm", "", { timeout: 5 })
    const confirmRequest = lastRequest(events)
    expect(await confirmation).toBe(false)
    expect(gate.respondConfirm(confirmRequest.id, true)).toBe(false)

    const before = events.length
    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    expect(await ui.select("Never shown", ["One"], { signal: alreadyAborted.signal })).toBeUndefined()
    expect(events).toHaveLength(before)
  })
})
