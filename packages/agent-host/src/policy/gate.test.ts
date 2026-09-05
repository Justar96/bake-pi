import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ApprovalRequest, EventEnvelope, EventName, EventPayload, TrustLevel } from "@bake-pi/contract"
import { Diagnostics } from "../diagnostics.ts"
import { EventEmitter } from "../emitter.ts"
import type { HostMessagePort } from "../parent-port.ts"
import { ApprovalGate } from "./gate.ts"
import { canonicalize } from "./paths.ts"

const SESSION = "session-1"

/**
 * A port that records instead of delivering.
 *
 * The gate's contract with the renderer is entirely in what it emits and when,
 * so the emitted envelopes are the assertion surface. Using the real
 * `EventEmitter` rather than a stub keeps the sequence-fence behavior in the
 * test: an approval card that arrived out of order relative to its tool call
 * would be a real defect and it would show up here.
 */
const recorder = (): { emitter: EventEmitter; events: EventEnvelope[] } => {
  const events: EventEnvelope[] = []
  const emitter = new EventEmitter()
  emitter.attach({
    on: () => {},
    start: () => {},
    postMessage: (envelope: EventEnvelope) => events.push(envelope),
    close: () => {},
  } as HostMessagePort)
  return { emitter, events }
}

const payloadsOf = <N extends EventName>(events: EventEnvelope[], name: N): EventPayload<N>[] =>
  events.filter((event) => event.name === name).map((event) => event.payload as EventPayload<N>)

const harness = (trust: TrustLevel, timeoutMs = 5_000) => {
  const root = canonicalize(mkdtempSync(join(tmpdir(), "bakepi-gate-")))
  const { emitter, events } = recorder()
  const gate = new ApprovalGate({
    emitter,
    diagnostics: new Diagnostics(),
    resolveContext: (sessionId) =>
      sessionId === SESSION ? { workspaceRoot: root, trust } : undefined,
    timeoutMs,
  })
  return { gate, events, root }
}

const requestFrom = (events: EventEnvelope[]): ApprovalRequest => {
  const requests = payloadsOf(events, "approval_requested")
  expect(requests).toHaveLength(1)
  return requests[0]!.request
}

describe("the gate lets through what the policy does not question", () => {
  test("a trusted in-workspace write proceeds without a card", async () => {
    const { gate, events, root } = harness("trusted")

    const verdict = await gate.evaluate(
      SESSION,
      root,
      { toolCallId: "t1", toolName: "write", input: { path: join(root, "a.ts"), content: "x" } },
      undefined,
    )

    expect(verdict).toBeUndefined()
    expect(payloadsOf(events, "approval_requested")).toHaveLength(0)
  })

  test("a read outside a trusted workspace proceeds without a card", async () => {
    const { gate, events, root } = harness("trusted")

    const verdict = await gate.evaluate(
      SESSION,
      root,
      { toolCallId: "t1", toolName: "read", input: { path: join(root, "..", "elsewhere.txt") } },
      undefined,
    )

    expect(verdict).toBeUndefined()
    expect(payloadsOf(events, "approval_requested")).toHaveLength(0)
  })
})

describe("a decision reaches the tool call that is waiting for it", () => {
  test("allow_once lets the call proceed and does not allow the next one", async () => {
    const { gate, events, root } = harness("untrusted")
    const call = { toolCallId: "t1", toolName: "read", input: { path: join(root, "a.ts") } }

    const first = gate.evaluate(SESSION, root, call, undefined)
    await Promise.resolve()
    expect(gate.respond(requestFrom(events).id, "allow_once")).toBe(true)
    expect(await first).toBeUndefined()

    // The second call raises its own card. An "allow once" that quietly covered
    // later calls would be the difference between what the user was shown and
    // what they granted.
    const second = gate.evaluate(SESSION, root, { ...call, toolCallId: "t2" }, undefined)
    await Promise.resolve()
    expect(gate.pendingFor(SESSION)).toHaveLength(1)
    gate.cancelSession(SESSION)
    expect(await second).toEqual({ block: true, reason: expect.stringContaining("cancelled") })
  })

  test("deny blocks the call, which is what actually stops the tool", async () => {
    const { gate, events, root } = harness("untrusted")

    const verdict = gate.evaluate(
      SESSION,
      root,
      { toolCallId: "t1", toolName: "write", input: { path: join(root, "a.ts"), content: "x" } },
      undefined,
    )
    await Promise.resolve()
    gate.respond(requestFrom(events).id, "deny")

    // `block: true` is the only thing Pi acts on. Emitting a denial event
    // without it would produce a UI that says denied over a tool that ran.
    expect(await verdict).toEqual({ block: true, reason: expect.stringContaining("denied") })
  })

  test("allow_for_session covers the same tool again and no other tool", async () => {
    const { gate, events, root } = harness("untrusted")

    const first = gate.evaluate(SESSION, root, { toolCallId: "t1", toolName: "read", input: { path: join(root, "a.ts") } }, undefined)
    await Promise.resolve()
    gate.respond(requestFrom(events).id, "allow_for_session")
    expect(await first).toBeUndefined()

    // Same tool: no card.
    const again = await gate.evaluate(SESSION, root, { toolCallId: "t2", toolName: "read", input: { path: join(root, "b.ts") } }, undefined)
    expect(again).toBeUndefined()
    expect(payloadsOf(events, "approval_requested")).toHaveLength(1)

    // A different tool still asks. The allowance is keyed by tool name, and a
    // user who allowed reads for the session did not allow writes.
    const other = gate.evaluate(SESSION, root, { toolCallId: "t3", toolName: "write", input: { path: join(root, "c.ts"), content: "x" } }, undefined)
    await Promise.resolve()
    expect(payloadsOf(events, "approval_requested")).toHaveLength(2)
    gate.cancelAll()
    expect(await other).toEqual({ block: true, reason: expect.stringContaining("cancelled") })
  })
})

describe("every path out of a pending request denies", () => {
  test("an expired request denies rather than waiting forever", async () => {
    const { gate, events, root } = harness("untrusted", 20)

    const verdict = await gate.evaluate(
      SESSION,
      root,
      { toolCallId: "t1", toolName: "read", input: { path: join(root, "a.ts") } },
      undefined,
    )

    expect(verdict).toEqual({ block: true, reason: expect.stringContaining("cancelled") })
    expect(payloadsOf(events, "approval_resolved")[0]).toEqual({
      requestId: expect.any(String),
      decision: "deny",
      resolvedBy: "cancelled",
    })
  })

  test("an abort denies what was still waiting", async () => {
    const { gate, root } = harness("untrusted")
    const controller = new AbortController()

    const verdict = gate.evaluate(
      SESSION,
      root,
      { toolCallId: "t1", toolName: "read", input: { path: join(root, "a.ts") } },
      controller.signal,
    )
    await Promise.resolve()
    controller.abort()

    expect(await verdict).toEqual({ block: true, reason: expect.stringContaining("cancelled") })
  })

  test("a signal already aborted when the call arrives does not park forever", async () => {
    // An already-aborted signal never fires its listener, so without an explicit
    // check the request would wait for the full timeout on a session that is
    // already stopping.
    const { gate, root } = harness("untrusted")

    const verdict = await gate.evaluate(
      SESSION,
      root,
      { toolCallId: "t1", toolName: "read", input: { path: join(root, "a.ts") } },
      AbortSignal.abort(),
    )

    expect(verdict).toEqual({ block: true, reason: expect.stringContaining("cancelled") })
  })

  test("closing a session denies its requests and forgets its allowances", async () => {
    const { gate, events, root } = harness("untrusted")

    const first = gate.evaluate(SESSION, root, { toolCallId: "t1", toolName: "read", input: { path: join(root, "a.ts") } }, undefined)
    await Promise.resolve()
    gate.respond(requestFrom(events).id, "allow_for_session")
    expect(await first).toBeUndefined()

    gate.cancelSession(SESSION)

    // The allowance did not survive the close, so the same tool asks again.
    const after = gate.evaluate(SESSION, root, { toolCallId: "t2", toolName: "read", input: { path: join(root, "a.ts") } }, undefined)
    await Promise.resolve()
    expect(gate.pendingFor(SESSION)).toHaveLength(1)
    gate.cancelAll()
    expect(await after).toEqual({ block: true, reason: expect.stringContaining("cancelled") })
  })

  test("a session close settles only its own requests", async () => {
    const { gate, root } = harness("untrusted")
    const pending = gate.evaluate(SESSION, root, { toolCallId: "t1", toolName: "read", input: { path: join(root, "a.ts") } }, undefined)
    await Promise.resolve()

    gate.cancelSession("some-other-session")
    expect(gate.pendingFor(SESSION)).toHaveLength(1)

    gate.cancelAll()
    expect(await pending).toEqual({ block: true, reason: expect.stringContaining("cancelled") })
  })
})

describe("a decision that matches nothing is dropped, never treated as an allow", () => {
  test("an unknown request id is refused without throwing", () => {
    const { gate } = harness("untrusted")
    expect(gate.respond("no-such-request", "allow_once")).toBe(false)
  })

  test("a second decision on the same request is refused", async () => {
    const { gate, events, root } = harness("untrusted")

    const verdict = gate.evaluate(SESSION, root, { toolCallId: "t1", toolName: "read", input: { path: join(root, "a.ts") } }, undefined)
    await Promise.resolve()
    const requestId = requestFrom(events).id

    expect(gate.respond(requestId, "deny")).toBe(true)
    // The late click. The call has already been denied; accepting an allow here
    // would resolve a promise nobody is holding and report success for a
    // decision that changed nothing.
    expect(gate.respond(requestId, "allow_once")).toBe(false)
    expect(await verdict).toEqual({ block: true, reason: expect.stringContaining("denied") })
    expect(payloadsOf(events, "approval_resolved")).toHaveLength(1)
  })
})

describe("a tool call from an unidentifiable session is blocked", () => {
  test("an unknown session blocks rather than falling back to trusted", async () => {
    // There is no workspace root to judge containment against and no card to ask
    // in, so there is no way to allow it responsibly.
    const { gate, events, root } = harness("trusted")

    const verdict = await gate.evaluate(
      "not-a-session",
      root,
      { toolCallId: "t1", toolName: "write", input: { path: join(root, "a.ts"), content: "x" } },
      undefined,
    )

    expect(verdict?.block).toBe(true)
    expect(payloadsOf(events, "approval_requested")).toHaveLength(0)
  })
})

describe("the card describes the call it is gating", () => {
  test("an escaping write is reported with its canonical target and reason", async () => {
    const { gate, events, root } = harness("trusted")

    const verdict = gate.evaluate(
      SESSION,
      root,
      { toolCallId: "t1", toolName: "write", input: { path: join(root, "..", "escape.txt"), content: "x" } },
      undefined,
    )
    await Promise.resolve()
    const request = requestFrom(events)

    expect(request.reason).toBe("outside_workspace")
    expect(request.sessionId).toBe(SESSION)
    expect(request.call).toMatchObject({ id: "t1", name: "write", source: "builtin", status: "pending_approval" })
    expect(request.call.targets).toEqual([
      { path: expect.stringContaining("escape.txt"), kind: "write", insideWorkspace: false },
    ])

    gate.cancelAll()
    await verdict
  })

  test("an unknown tool is flagged as coming from an extension", async () => {
    const { gate, events, root } = harness("trusted")

    const verdict = gate.evaluate(
      SESSION,
      root,
      { toolCallId: "t1", toolName: "deploy_to_production", input: { region: "eu" } },
      undefined,
    )
    await Promise.resolve()
    const request = requestFrom(events)

    expect(request.reason).toBe("targets_unknown")
    expect(request.call.source).toBe("extension")
    expect(request.call.targets).toEqual([])

    gate.cancelAll()
    await verdict
  })

  test("approval events carry the session id, so they sequence with its tool events", async () => {
    const { gate, events, root } = harness("untrusted")

    const verdict = gate.evaluate(SESSION, root, { toolCallId: "t1", toolName: "read", input: { path: join(root, "a.ts") } }, undefined)
    await Promise.resolve()
    gate.respond(requestFrom(events).id, "allow_once")
    await verdict

    const approval = events.filter((event) => event.name.startsWith("approval_"))
    expect(approval).toHaveLength(2)
    for (const event of approval) expect(event.sessionId).toBe(SESSION)
    expect(approval[0]!.sequence).toBeLessThan(approval[1]!.sequence)
  })
})
