import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import type { SessionSnapshot } from "@bake-pi/contract"
import { EventStream } from "../../../apps/desktop/src/renderer/store/stream.ts"
import { type SessionState, initialState, reduce } from "../../../apps/desktop/src/renderer/store/reducers/session.ts"
import { Diagnostics } from "../src/diagnostics.ts"
import { EventEmitter } from "../src/emitter.ts"
import { SessionHost } from "../src/session-host.ts"
import type { HostMessagePort } from "../src/parent-port.ts"
import { fakeSession } from "./fake-session.ts"

/**
 * The round trip, for the one case where the stream is allowed to lose events.
 *
 * `emitter.test.ts` proves the host announces a discard and `stream.test.ts`
 * proves the renderer notices a hole. Neither answers the question the milestone
 * actually asks, which is whether what the user ends up looking at matches what
 * the session actually is. That needs both halves wired to each other through a
 * real port, and it needs the comparison to be against the host's own snapshot
 * rather than against an expectation written by hand — a hand-written one would
 * pass just as happily if both sides were wrong in the same way.
 *
 * This is the only test that crosses the process boundary in-process. It imports
 * the renderer's stream and reducer directly, which shipped code may never do;
 * the boundary suite excludes test files precisely so that a test can stand in
 * both places at once.
 */

const assistantMessage = (text: string): never =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: 1,
    stopReason: "stop",
  }) as never

/** Big enough that a few hundred breach the cap. */
const FAT = "x".repeat(65_536)

/**
 * The renderer's port, as the host's narrower interface sees it.
 *
 * `drop` is how an event is lost *after* the host has emitted it. That is the
 * one failure the host cannot detect by construction: it consumed a sequence
 * number, it believes it delivered, and only the absence of that number on the
 * far side is evidence. A schema check the renderer fails is the concrete
 * instance of this — `stream.test.ts` drives that one directly — but the shape
 * is the same for a structured-clone failure or a port that lost a message.
 */
const asHostPort = (port: MessagePort, drop?: (envelope: { name: string }) => boolean): HostMessagePort => ({
  postMessage: (message: unknown) => {
    if (drop?.(message as { name: string }) === true) return
    port.postMessage(message)
  },
  on: () => {},
  start: () => port.start(),
  close: () => port.close(),
})

interface Renderer {
  /** What the interface would be showing. Undefined until a snapshot gives it a baseline. */
  state: SessionState | undefined
  resyncs: string[]
}

/**
 * The renderer, reduced to the part under test: intake, projection, and the one
 * command it sends on its own initiative.
 *
 * The baseline rule is `session-store.ts`'s: an event for a session with no
 * snapshot has nothing to apply to and is dropped. That is what makes the
 * scenario below sharp — after a discard there may be no baseline at all, and
 * only the forced snapshot produces one.
 */
const renderer = (port: MessagePort, host: SessionHost): Renderer => {
  const view: Renderer = { state: undefined, resyncs: [] }
  const stream = new EventStream()

  stream.onGap((sessionId) => {
    view.resyncs.push(sessionId)
    // Stands in for `send("resync_session", …)`, which reaches this same call
    // through the preload and the main-process router.
    host.resync("gap")
  })

  stream.subscribe((event) => {
    if (event.sessionId === undefined) return
    if (event.name === "session_snapshot") {
      view.state = initialState((event.payload as { snapshot: SessionSnapshot }).snapshot)
      return
    }
    if (view.state === undefined) return
    view.state = reduce(view.state, event.name, event.payload)
  })

  stream.connect(port)
  return view
}

/** Ports deliver on a task, so yield until the queue drains. */
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

/**
 * Everything the user can actually see. `sequence` and `afterGap` are excluded
 * on purpose: they describe the transport, and comparing them would only assert
 * that a snapshot equals itself.
 */
const visible = (snapshot: SessionSnapshot): unknown => ({
  messages: snapshot.messages,
  status: snapshot.status,
  queue: snapshot.queue,
  approvals: snapshot.approvals,
  usage: snapshot.usage,
  model: snapshot.model,
})

describe("a projection that lost events ends up equal to the session", () => {
  test("after an overflowing discard, what the renderer shows is what the host holds", async () => {
    const fake = fakeSession()
    const emitter = new EventEmitter()
    const host = new SessionHost({
      runtime: fake.runtime,
      emitter,
      diagnostics: new Diagnostics(),
      workspaceId: "w1",
      workspaceRoot: tmpdir(),
      trust: "trusted",
    })
    host.attach()

    const channel = new MessageChannel()
    const view = renderer(channel.port2, host)
    emitter.onGap((sessionId) => {
      // Exactly what `runtime.ts` registers. The emitter reports; the host repairs.
      if (sessionId === host.sessionId) host.resync("gap")
    })

    // No port yet, and the session is working. This is the window the host
    // buffers in: a restored session answering a prompt before a window exists.
    const first = assistantMessage("the answer nobody was watching")
    fake.messages.push(first)
    fake.emit({ type: "message_end", message: first } as never)
    while (emitter.droppedWhileDetached === 0) {
      emitter.emit("block_delta", { messageId: "m0", blockIndex: 0, textDelta: FAT }, host.sessionId)
    }
    // Discarded along with everything else: the renderer will never be told
    // about this message by an event.
    const second = assistantMessage("and neither was this one")
    fake.messages.push(second)
    fake.emit({ type: "message_end", message: second } as never)

    channel.port1.start()
    emitter.attach(asHostPort(channel.port1))
    await settle()

    expect(view.state).toBeDefined()
    expect(visible(view.state!.snapshot)).toEqual(visible(host.snapshot()))
    // Both messages are there, including the one no surviving event described.
    expect(view.state!.snapshot.messages).toHaveLength(2)
    // And the interface can say why history jumped rather than leaving the user
    // to notice on their own.
    expect(view.state!.gap).toBe(true)

    channel.port1.close()
    channel.port2.close()
  })

  test("a hole the host cannot see is repaired by the renderer asking", async () => {
    const fake = fakeSession()
    const emitter = new EventEmitter()
    const host = new SessionHost({
      runtime: fake.runtime,
      emitter,
      diagnostics: new Diagnostics(),
      workspaceId: "w1",
      workspaceRoot: tmpdir(),
      trust: "trusted",
    })
    host.attach()

    const channel = new MessageChannel()
    const view = renderer(channel.port2, host)
    channel.port1.start()
    let swallow = false
    emitter.attach(asHostPort(channel.port1, (envelope) => swallow && envelope.name === "message_added"))

    // A baseline first, so the renderer has something to detect a hole against.
    host.resync("replacement")
    await settle()
    expect(view.resyncs).toEqual([])

    // The host announces a message, and the announcement is lost on the way. The
    // host consumed a sequence number for it and believes it delivered; the only
    // trace is that number never arriving.
    swallow = true
    const message = assistantMessage("streamed while an event went missing")
    fake.emit({ type: "message_start", message } as never)
    swallow = false

    // Pi appends the message and the turn ends, which is what the renderer does
    // see — and what exposes the hole, because its sequence is two past the last
    // one that arrived.
    fake.messages.push(message)
    fake.emit({ type: "message_end", message } as never)
    await settle()

    expect(view.resyncs).toEqual([host.sessionId])
    await settle()

    // The message that arrived while the stream was holed is present, because
    // the repair is a snapshot of the session rather than a replay of events.
    expect(visible(view.state!.snapshot)).toEqual(visible(host.snapshot()))
    expect(view.state!.snapshot.messages).toHaveLength(1)

    channel.port1.close()
    channel.port2.close()
  })
})
