import { describe, expect, test } from "bun:test"
import type { EventEnvelope, SessionSnapshot } from "@bake-pi/contract"
import { reduce, initialState } from "./reducers/session.ts"
import { EventStream, type StreamEvent } from "./stream.ts"

const SESSION = "s1"

const snapshotAt = (sequence: number, texts: string[]): SessionSnapshot => ({
  sequence,
  summary: {
    id: SESSION,
    workspaceId: "w1",
    title: "test",
    createdAt: 0,
    updatedAt: 0,
    messageCount: texts.length,
    path: "/tmp/w1",
  },
  status: "idle",
  messages: texts.map((text, index) => ({
    id: `m${index}`,
    role: "assistant" as const,
    status: "complete" as const,
    blocks: [{ index: 0, kind: "text" as const, text }],
    createdAt: 0,
  })),
  queue: [],
  approvals: [],
  model: { modelId: "test", providerId: "test-provider", thinkingLevel: "off", availableThinkingLevels: ["off"] },
  usage: { turnCount: 0, total: { inputTokens: 0, outputTokens: 0 } },
  afterGap: false,
})

const envelope = (name: string, sequence: number, payload: unknown): EventEnvelope =>
  ({ kind: "event", name, sequence, sessionId: SESSION, payload }) as EventEnvelope

interface Driven {
  received: StreamEvent[]
  gaps: { sessionId: string; dropped: number }[]
}

/** Drives an `EventStream` through a real `MessagePort`, the way the preload does. */
const driveAll = async (envelopes: EventEnvelope[]): Promise<Driven> => {
  const channel = new MessageChannel()
  const stream = new EventStream()
  const received: StreamEvent[] = []
  const gaps: { sessionId: string; dropped: number }[] = []
  stream.subscribe((event) => received.push(event))
  stream.onGap((sessionId, dropped) => gaps.push({ sessionId, dropped }))
  stream.connect(channel.port2)

  channel.port1.start()
  for (const item of envelopes) channel.port1.postMessage(item)
  // Ports deliver on a task, so yield until the queue drains.
  await new Promise((resolve) => setTimeout(resolve, 10))
  stream.disconnect()
  channel.port1.close()
  return { received, gaps }
}

const drive = async (envelopes: EventEnvelope[]): Promise<StreamEvent[]> =>
  (await driveAll(envelopes)).received

test("the receiver returns batched delivery credit on the same port", async () => {
  const channel = new MessageChannel()
  const stream = new EventStream()
  const acknowledgements: unknown[] = []
  channel.port1.onmessage = (message) => acknowledgements.push(message.data)
  channel.port1.start()
  stream.connect(channel.port2)

  channel.port1.postMessage(envelope("session_status_changed", 1, { status: "streaming" }))
  channel.port1.postMessage(envelope("session_status_changed", 2, { status: "idle" }))
  await new Promise((resolve) => setTimeout(resolve, 10))

  expect(acknowledgements).toEqual([{ kind: "event_ack", count: 2 }])
  stream.disconnect()
  channel.port1.close()
})

describe("the sequence fence", () => {
  test("events at or below a snapshot's sequence are discarded, and those above are applied", async () => {
    const received = await drive([
      envelope("session_snapshot", 5, { snapshot: snapshotAt(5, ["kept"]) }),
      // Stale: produced before the snapshot was taken, so it is already
      // reflected in it. Applying it again would duplicate the delta.
      envelope("block_delta", 4, { messageId: "m0", blockIndex: 0, textDelta: "stale" }),
      envelope("block_delta", 5, { messageId: "m0", blockIndex: 0, textDelta: "boundary" }),
      envelope("block_delta", 6, { messageId: "m0", blockIndex: 0, textDelta: " fresh" }),
    ])

    expect(received.map((event) => event.sequence)).toEqual([5, 6])
    expect(received[1]?.name).toBe("block_delta")
  })

  test("a replayed sequence number is dropped rather than applied twice", async () => {
    const received = await drive([
      envelope("session_snapshot", 0, { snapshot: snapshotAt(0, [""]) }),
      envelope("block_delta", 1, { messageId: "m0", blockIndex: 0, textDelta: "a" }),
      envelope("block_delta", 1, { messageId: "m0", blockIndex: 0, textDelta: "a" }),
      envelope("block_delta", 2, { messageId: "m0", blockIndex: 0, textDelta: "b" }),
    ])

    expect(received.map((event) => event.sequence)).toEqual([0, 1, 2])
  })

  test("a malformed event is dropped without tearing down the stream", async () => {
    const received = await drive([
      envelope("session_snapshot", 0, { snapshot: snapshotAt(0, [""]) }),
      // blockIndex must be an integer; this payload fails its schema.
      envelope("block_delta", 1, { messageId: "m0", blockIndex: "one", textDelta: "x" }),
      envelope("block_delta", 2, { messageId: "m0", blockIndex: 0, textDelta: "ok" }),
    ])

    expect(received.map((event) => event.name)).toEqual(["session_snapshot", "block_delta"])
    expect(received[1]?.sequence).toBe(2)
  })

  test("a failure that is not a schema rejection is raised rather than swallowed", () => {
    // The distinction the catch in `#receive` turns on, and the reason it is
    // narrow. A schema rejection means one bad event; anything else means the
    // intake cannot validate at all, so every event after it dies the same way
    // — including the snapshot that would repair the projection — and the gap
    // counter never fires either, because it only advances on an accepted
    // event. That is not a hole in the timeline, it is a blank one, and it has
    // to be loud on the first event rather than silent forever.
    //
    // A throwing getter stands in for it because it makes `acceptEvent` fail
    // somewhere other than its own schema check, which is exactly the shape the
    // real one had: a validator that could not be built under `script-src`.
    // Structured clone would drop the getter, so this drives `onmessage`
    // directly rather than through a real port.
    const port = { onmessage: null as ((message: MessageEvent) => void) | null, postMessage: () => {}, start: () => {}, close: () => {} }
    const stream = new EventStream()
    stream.connect(port as unknown as MessagePort)

    const hostile = { get kind(): string { throw new TypeError("intake is broken") } }
    expect(() => port.onmessage?.({ data: hostile } as MessageEvent)).toThrow(TypeError)
  })

  test("a second snapshot replaces the projection and re-fences", async () => {
    const received = await drive([
      envelope("session_snapshot", 3, { snapshot: snapshotAt(3, ["first"]) }),
      envelope("block_delta", 4, { messageId: "m0", blockIndex: 0, textDelta: "x" }),
      envelope("session_snapshot", 9, { snapshot: snapshotAt(9, ["second"]) }),
      // Below the new fence: belongs to the history the snapshot already carries.
      envelope("block_delta", 7, { messageId: "m0", blockIndex: 0, textDelta: "stale" }),
      envelope("block_delta", 10, { messageId: "m0", blockIndex: 0, textDelta: "!" }),
    ])

    expect(received.map((event) => event.sequence)).toEqual([3, 4, 9, 10])
  })
})

/**
 * The gap the host cannot see.
 *
 * An event dropped on arrival — one that failed its schema check — is a hole the
 * sending side has no way to know about: from the host's view it was delivered.
 * The only trace is a sequence number that never shows up, so the comparison
 * below is the entire detection mechanism, and a snapshot is the entire repair.
 */
describe("a missing sequence number is noticed and repaired", () => {
  test("a hole in the sequence is reported with the number of events lost", async () => {
    const driven = await driveAll([
      envelope("session_snapshot", 1, { snapshot: snapshotAt(1, ["a"]) }),
      envelope("block_delta", 2, { messageId: "m0", blockIndex: 0, textDelta: "x" }),
      // 3, 4 and 5 never arrive.
      envelope("block_delta", 6, { messageId: "m0", blockIndex: 0, textDelta: "y" }),
    ])

    expect(driven.gaps).toEqual([{ sessionId: SESSION, dropped: 3 }])
  })

  test("an event that fails its schema check becomes a gap on the next one that does not", async () => {
    const driven = await driveAll([
      envelope("session_snapshot", 1, { snapshot: snapshotAt(1, ["a"]) }),
      // blockIndex must be an integer. Dropped on arrival, so the host believes
      // it was delivered and nothing else will ever notice.
      envelope("block_delta", 2, { messageId: "m0", blockIndex: "two", textDelta: "x" }),
      envelope("block_delta", 3, { messageId: "m0", blockIndex: 0, textDelta: "y" }),
    ])

    expect(driven.gaps).toEqual([{ sessionId: SESSION, dropped: 1 }])
  })

  test("the event in hand is still applied, because it is newer than the projection", async () => {
    const driven = await driveAll([
      envelope("session_snapshot", 1, { snapshot: snapshotAt(1, ["a"]) }),
      envelope("block_delta", 9, { messageId: "m0", blockIndex: 0, textDelta: "y" }),
    ])

    expect(driven.received.map((event) => event.sequence)).toEqual([1, 9])
  })

  test("a session's first event is not a gap, because there is nothing to be missing from", async () => {
    const driven = await driveAll([envelope("session_snapshot", 47, { snapshot: snapshotAt(47, ["a"]) })])
    expect(driven.gaps).toEqual([])
  })

  test("a gap is reported once, not once per event that follows it", async () => {
    const driven = await driveAll([
      envelope("session_snapshot", 1, { snapshot: snapshotAt(1, ["a"]) }),
      envelope("block_delta", 5, { messageId: "m0", blockIndex: 0, textDelta: "a" }),
      envelope("block_delta", 9, { messageId: "m0", blockIndex: 0, textDelta: "b" }),
      envelope("block_delta", 14, { messageId: "m0", blockIndex: 0, textDelta: "c" }),
    ])

    // Each of those is a hole of its own, and each would ask the host for the
    // same snapshot. One request answers all three.
    expect(driven.gaps).toHaveLength(1)
  })

  test("the snapshot clears the flag, so a later gap is reported again", async () => {
    const driven = await driveAll([
      envelope("session_snapshot", 1, { snapshot: snapshotAt(1, ["a"]) }),
      envelope("block_delta", 5, { messageId: "m0", blockIndex: 0, textDelta: "a" }),
      // The repair arrives, re-fencing the session.
      envelope("session_snapshot", 6, { snapshot: { ...snapshotAt(6, ["a"]), afterGap: true } }),
      envelope("block_delta", 20, { messageId: "m0", blockIndex: 0, textDelta: "b" }),
    ])

    expect(driven.gaps.map((gap) => gap.dropped)).toEqual([3, 13])
  })
})

describe("the reducer applies a stream to a projection", () => {
  test("deltas accumulate onto the addressed block", () => {
    let state = initialState(snapshotAt(0, [""]))
    state = reduce(state, "block_delta", { messageId: "m0", blockIndex: 0, textDelta: "Hel" })
    state = reduce(state, "block_delta", { messageId: "m0", blockIndex: 0, textDelta: "lo" })

    const block = state.snapshot.messages[0]?.blocks[0]
    expect(block?.kind === "text" ? block.text : undefined).toBe("Hello")
  })

  test("a delta for an unknown message is dropped, not synthesized", () => {
    const state = initialState(snapshotAt(0, ["a"]))
    const next = reduce(state, "block_delta", { messageId: "m99", blockIndex: 0, textDelta: "x" })
    expect(next).toBe(state)
    expect(next.snapshot.messages).toHaveLength(1)
  })

  test("a snapshot replaces the projection wholesale, discarding accumulated deltas", () => {
    let state = initialState(snapshotAt(0, ["partial"]))
    state = reduce(state, "block_delta", { messageId: "m0", blockIndex: 0, textDelta: " and more" })
    state = reduce(state, "session_snapshot", { snapshot: snapshotAt(7, ["authoritative"]) })

    const block = state.snapshot.messages[0]?.blocks[0]
    expect(block?.kind === "text" ? block.text : undefined).toBe("authoritative")
    expect(state.snapshot.sequence).toBe(7)
  })

  test("a gap is recorded so the interface can say history is incomplete", () => {
    let state = initialState(snapshotAt(0, ["a"]))
    state = reduce(state, "stream_gap", { sessionId: SESSION, droppedEvents: 12 })
    expect(state.gap).toBe(true)

    state = reduce(state, "session_snapshot", { snapshot: { ...snapshotAt(20, ["a"]), afterGap: true } })
    // Still flagged: the resync happened, and the user is told why the timeline
    // jumped rather than being left to notice on their own.
    expect(state.gap).toBe(true)
  })

  test("blocks stay ordered by index regardless of arrival order", () => {
    let state = initialState(snapshotAt(0, [""]))
    state = reduce(state, "block_started", {
      messageId: "m0",
      block: { index: 2, kind: "text", text: "third" },
    })
    state = reduce(state, "block_started", {
      messageId: "m0",
      block: { index: 1, kind: "reasoning", text: "second", redacted: false },
    })

    expect(state.snapshot.messages[0]?.blocks.map((block) => block.index)).toEqual([0, 1, 2])
  })

  test("approval cards survive in projection until their matching resolution", () => {
    const request = {
      id: "approval-1",
      sessionId: "s1",
      call: {
        id: "call-1",
        name: "write",
        source: "builtin" as const,
        args: {},
        targets: [],
        status: "pending_approval" as const,
      },
      reason: "workspace_untrusted" as const,
      requestedAt: 1,
    }
    const initial = initialState(snapshotAt(0, []))
    const waiting = reduce(initial, "approval_requested", { request })

    expect(waiting.snapshot.status).toBe("awaiting_approval")
    expect(waiting.snapshot.approvals).toEqual([request])

    const resolved = reduce(waiting, "approval_resolved", {
      requestId: request.id,
      decision: "allow_once",
      resolvedBy: "user",
    })
    expect(resolved.snapshot.approvals).toEqual([])
    expect(resolved.snapshot.status).toBe("streaming")
  })
})
