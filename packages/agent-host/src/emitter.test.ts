import { describe, expect, test } from "bun:test"
import { MAX_QUEUED_SESSION_BYTES, acceptEvent } from "@bake-pi/contract"
import { EVENT_DELIVERY_WINDOW_BYTES, EventEmitter } from "./emitter.ts"
import type { HostMessagePort } from "./parent-port.ts"
import { announceQuarantine } from "./supervision.ts"

/**
 * What the emitter does when it cannot deliver.
 *
 * This host buffers before the renderer's port arrives and whenever a connected
 * renderer has spent its delivery credit. Both are bounded, which means events
 * can be discarded rather than making memory growth the backpressure policy.
 *
 * A discard that says nothing is the failure this file exists to prevent. The
 * renderer would receive a stream whose sequence numbers simply skip, and its
 * projection would be missing a message with no indication that anything was
 * lost. So a discard is followed by a `stream_gap` and a request for the
 * snapshot that repairs it, in that order.
 */

/** What `acceptEvent` hands back: the envelope with its name narrowed to one the contract knows. */
type Accepted = ReturnType<typeof acceptEvent>

interface Recorded {
  port: HostMessagePort
  sent: Accepted[]
  acknowledge(count: number): void
  remoteClose(): void
}

const recordingPort = (): Recorded => {
  const sent: Accepted[] = []
  let onMessage: ((event: { data: unknown }) => void) | undefined
  let onClose: (() => void) | undefined
  return {
    sent,
    acknowledge: (count) => onMessage?.({ data: { kind: "event_ack", count } }),
    remoteClose: () => onClose?.(),
    port: {
      postMessage: (message: unknown) => {
        // Validated here rather than trusted: an envelope the contract rejects
        // is one the renderer drops, which would make a gap announcement itself
        // a source of gaps.
        sent.push(acceptEvent(message))
      },
      on: (event, listener) => {
        if (event === "message") onMessage = listener as (event: { data: unknown }) => void
        else onClose = listener as () => void
      },
      start: () => {},
      close: () => {},
    },
  }
}

describe("a connected renderer owns bounded delivery credit", () => {
  test("events wait behind the byte window until the renderer acknowledges them", () => {
    const emitter = new EventEmitter()
    const recorded = recordingPort()
    emitter.attach(recorded.port)

    const count = Math.ceil(EVENT_DELIVERY_WINDOW_BYTES / FAT_DELTA.length) * 3
    for (let index = 0; index < count; index += 1) fatDelta(emitter, "s1")

    expect(recorded.sent.length).toBeGreaterThan(0)
    expect(recorded.sent.length).toBeLessThan(count)
    while (recorded.sent.length < count) recorded.acknowledge(recorded.sent.length)
    expect(recorded.sent).toHaveLength(count)
  })

  test("delivery credit counts UTF-8 bytes rather than JavaScript code units", () => {
    const emitter = new EventEmitter()
    const recorded = recordingPort()
    emitter.attach(recorded.port)
    // Each delta is exactly the contract's 65,536-code-unit ceiling, but its
    // four-byte code points make nine of them exceed a one-megabyte byte window.
    // Counting JavaScript string length would incorrectly send all nine.
    const unicode = "💾".repeat(32_768)

    for (let index = 0; index < 9; index += 1) {
      emitter.emit("block_delta", { messageId: "m0", blockIndex: 0, textDelta: unicode }, "s1")
    }

    expect(recorded.sent.length).toBeLessThan(9)
    while (recorded.sent.length < 9) recorded.acknowledge(recorded.sent.length)
    expect(recorded.sent).toHaveLength(9)
  })

  test("a remotely closed port returns later events to the bounded queue", () => {
    const emitter = new EventEmitter()
    const first = recordingPort()
    emitter.attach(first.port)
    first.remoteClose()

    emitter.emit("session_status_changed", { status: "idle" }, "s1")
    expect(first.sent).toEqual([])

    const replacement = recordingPort()
    emitter.attach(replacement.port)
    expect(replacement.sent.map((event) => event.name)).toEqual(["session_status_changed"])
  })

  test("every replacement port asks the runtime to re-fence its open sessions", () => {
    const emitter = new EventEmitter()
    const attachments: { sessions: string[]; restoreProjection: boolean }[] = []
    emitter.onAttach((alreadyResynced, restoreProjection) => attachments.push({
      sessions: [...alreadyResynced],
      restoreProjection,
    }))

    emitter.attach(recordingPort().port)
    emitter.attach(recordingPort().port, true)

    expect(attachments).toEqual([
      { sessions: [], restoreProjection: false },
      { sessions: [], restoreProjection: true },
    ])
  })
})

/** Big enough that a handful of these breach the cap without allocating it all at once. */
const FAT_DELTA = "x".repeat(65_536)

const fatDelta = (emitter: EventEmitter, sessionId: string): void => {
  emitter.emit("block_delta", { messageId: "m0", blockIndex: 0, textDelta: FAT_DELTA }, sessionId)
}

/**
 * Emits until the detached buffer discards, and answers how many events that
 * took.
 *
 * Driven to the observed discard rather than to a computed count: the cap is on
 * serialized bytes including envelope overhead, so the event that breaches it is
 * not the one arithmetic on the payload size predicts. Stopping exactly there
 * also leaves the buffer empty, which is what lets the ordering test below say
 * something about what follows a discard.
 */
const overflow = (emitter: EventEmitter, sessionId: string): number => {
  let sent = 0
  while (emitter.droppedWhileDetached === 0) {
    fatDelta(emitter, sessionId)
    sent += 1
    if (sent > MAX_QUEUED_SESSION_BYTES / FAT_DELTA.length + 2) throw new Error("the cap was never breached")
  }
  return sent
}

describe("a discarded buffer is announced rather than hidden", () => {
  test("nothing is announced when nothing was dropped", () => {
    const emitter = new EventEmitter()
    const gaps: string[] = []
    emitter.onGap((sessionId) => gaps.push(sessionId))

    emitter.emit("session_status_changed", { status: "idle" }, "s1")
    const recorded = recordingPort()
    emitter.attach(recorded.port)

    expect(gaps).toEqual([])
    expect(recorded.sent.map((envelope) => envelope.name)).toEqual(["session_status_changed"])
  })

  test("breaching the cap discards, and the sessions that lost events are named on attach", () => {
    const emitter = new EventEmitter()
    const gaps: { sessionId: string; dropped: number }[] = []
    emitter.onGap((sessionId, dropped) => gaps.push({ sessionId, dropped }))

    const sent = overflow(emitter, "s1")
    const recorded = recordingPort()
    emitter.attach(recorded.port)

    expect(gaps.map((gap) => gap.sessionId)).toEqual(["s1"])
    // Every event that went into the discard is counted, including the one whose
    // arrival breached the cap. A count that is short by one is still wrong.
    expect(gaps[0]?.dropped).toBe(sent)
    expect(emitter.droppedWhileDetached).toBe(sent)
  })

  test("the gap reaches the renderer as an event, not only as a host-side callback", () => {
    const emitter = new EventEmitter()
    overflow(emitter, "s1")
    const recorded = recordingPort()
    emitter.attach(recorded.port)

    const gap = recorded.sent.find((envelope) => envelope.name === "stream_gap")
    expect(gap?.sessionId).toBe("s1")
    expect(gap?.payload).toMatchObject({ sessionId: "s1" })
  })

  test("each session is repaired on its own, because a snapshot is per session", () => {
    const emitter = new EventEmitter()
    const gaps: string[] = []
    emitter.onGap((sessionId) => gaps.push(sessionId))

    // One buffer, two sessions writing into it: the discard takes both.
    let index = 0
    while (emitter.droppedWhileDetached === 0) {
      fatDelta(emitter, index % 2 === 0 ? "s1" : "s2")
      index += 1
    }
    emitter.attach(recordingPort().port)

    expect([...gaps].sort()).toEqual(["s1", "s2"])
  })

  test("the announcement lands behind whatever survived the discard", () => {
    const emitter = new EventEmitter()
    overflow(emitter, "s1")
    // Buffered after the discard, so it is still deliverable and still older
    // than the gap. Announcing first would put the snapshot that follows behind
    // an event that predates it, and the fence would discard the newer state.
    emitter.emit("session_status_changed", { status: "idle" }, "s1")

    const recorded = recordingPort()
    emitter.attach(recorded.port)

    expect(recorded.sent.map((envelope) => envelope.name)).toEqual(["session_status_changed", "stream_gap"])
  })

  test("a session closed before the port arrives is not resynced", () => {
    const emitter = new EventEmitter()
    const gaps: string[] = []
    emitter.onGap((sessionId) => gaps.push(sessionId))

    overflow(emitter, "s1")
    // There is no projection left to repair, and no host left to build one.
    emitter.forgetSession("s1")
    emitter.attach(recordingPort().port)

    expect(gaps).toEqual([])
  })

  test("a gap is announced once, not on every later attach", () => {
    const emitter = new EventEmitter()
    const gaps: string[] = []
    emitter.onGap((sessionId) => gaps.push(sessionId))

    overflow(emitter, "s1")
    emitter.attach(recordingPort().port)
    emitter.detach()
    emitter.attach(recordingPort().port)

    expect(gaps).toEqual(["s1"])
  })
})

/**
 * The supervisor's one message to the renderer, which it cannot send itself.
 *
 * Main decides a quarantine and holds no end of the event port, so the decision
 * travels in the handshake and is announced from the host. A session dropped
 * without a word leaves a card in the interface with nothing behind it: its
 * events stop, no snapshot replaces it, and nothing says why.
 */
describe("a session the supervisor refused to bring back", () => {
  test("each quarantined session is announced on its own stream", () => {
    const emitter = new EventEmitter()
    const recorded = recordingPort()
    emitter.attach(recorded.port)

    announceQuarantine(emitter, ["s1", "s2"])

    expect(recorded.sent.map((envelope) => [envelope.name, envelope.sessionId])).toEqual([
      ["session_disconnected", "s1"],
      ["session_disconnected", "s2"],
    ])
    // Quarantined, not merely disconnected. The renderer shows a different thing
    // for a session that will not come back on its own.
    expect(recorded.sent[0]?.payload).toEqual({ sessionId: "s1", quarantined: true })
  })

  test("an ordinary start announces nothing", () => {
    const emitter = new EventEmitter()
    const recorded = recordingPort()
    emitter.attach(recorded.port)

    announceQuarantine(emitter, undefined)
    announceQuarantine(emitter, [])

    expect(recorded.sent).toEqual([])
  })
})
