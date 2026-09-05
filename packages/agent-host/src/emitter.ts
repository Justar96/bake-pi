import {
  type EventEnvelope,
  type EventName,
  type EventPayload,
  MAX_QUEUED_SESSION_BYTES,
  SESSION_SCOPED_EVENTS,
  isEventDeliveryAck,
} from "@bake-pi/contract"
import type { HostMessagePort } from "./parent-port.ts"

/** Enough for several streamed blocks, small enough to bound a stalled port. */
export const EVENT_DELIVERY_WINDOW_BYTES = 1024 * 1024

/**
 * The event stream, and the one place the sequence fence is maintained.
 *
 * Sequence numbers are per session and strictly monotonic. A snapshot carries
 * the sequence it was taken at, and the renderer discards everything at or
 * below it. That single rule is what makes the stream resyncable without an
 * unbounded buffer anywhere.
 */
export class EventEmitter {
  #port: HostMessagePort | undefined
  #sequences = new Map<string, number>()
  #hostSequence = 0
  /** Events not yet handed to Electron, whether detached or awaiting receiver credit. */
  #pending: { envelope: EventEnvelope; bytes: number }[] = []
  #pendingHead = 0
  #pendingBytes = 0
  #inFlight: number[] = []
  #inFlightHead = 0
  #inFlightBytes = 0
  #droppedWhileDetached = 0
  /** Sessions that lost events to the cap, and how many, until the gap is announced. */
  #droppedPerSession = new Map<string, number>()
  #onGap: ((sessionId: string, droppedEvents: number) => void) | undefined
  #onAttach: ((alreadyResynced: ReadonlySet<string>, restoreProjection: boolean) => void) | undefined

  /**
   * Registers what to do about a session whose events were discarded.
   *
   * The emitter cannot repair a gap itself: the repair is a snapshot, and only
   * the session host can build one. So it reports, and the runtime resyncs.
   */
  onGap(handler: (sessionId: string, droppedEvents: number) => void): void {
    this.#onGap = handler
  }

  /** Re-fences every open session when a new renderer document takes the port. */
  onAttach(handler: (alreadyResynced: ReadonlySet<string>, restoreProjection: boolean) => void): void {
    this.#onAttach = handler
  }

  attach(port: HostMessagePort, restoreProjection = false): void {
    const previous = this.#port
    this.#port = port
    this.#inFlight = []
    this.#inFlightHead = 0
    this.#inFlightBytes = 0
    port.on("message", (event) => {
      if (!("data" in event) || !isEventDeliveryAck(event.data)) return
      this.#acknowledge(event.data.count)
    })
    port.on("close", () => {
      if (this.#port !== port) return
      this.#port = undefined
      this.#inFlight = []
      this.#inFlightHead = 0
      this.#inFlightBytes = 0
    })
    port.start()
    previous?.close()
    this.#drain()
    // After the flush, never before: the gap announcement and the snapshot that
    // follows it must land behind whatever survived the discard, or the
    // snapshot would be superseded by events that predate it.
    const alreadyResynced = this.#announceGaps()
    this.#onAttach?.(alreadyResynced, restoreProjection)
    this.#drain()
  }

  detach(): void {
    const port = this.#port
    this.#port = undefined
    this.#inFlight = []
    this.#inFlightHead = 0
    this.#inFlightBytes = 0
    port?.close()
  }

  /** The sequence the next event will carry. A snapshot is taken *at* this value. */
  sequenceFor(sessionId: string): number {
    return this.#sequences.get(sessionId) ?? 0
  }

  emit<N extends EventName>(name: N, payload: EventPayload<N>, sessionId?: string): void {
    if (SESSION_SCOPED_EVENTS.has(name) && sessionId === undefined) {
      // A session event routed to no session is silently dropped by the
      // renderer and looks exactly like a lost token. Fail here instead.
      throw new Error(`event ${name} is session-scoped but was emitted without a session id`)
    }

    const sequence = sessionId === undefined ? (this.#hostSequence += 1) : this.#nextFor(sessionId)
    const envelope: EventEnvelope = {
      kind: "event",
      name,
      sequence,
      ...(sessionId === undefined ? {} : { sessionId }),
      payload,
    }

    this.#buffer(envelope)
    this.#drain()
  }

  /**
   * Resets a session's counter. Called when a snapshot is about to be sent
   * after a gap, so the renderer's discard rule has a clean fence to work from.
   */
  resetSession(sessionId: string): number {
    this.#sequences.set(sessionId, 0)
    return 0
  }

  forgetSession(sessionId: string): void {
    this.#sequences.delete(sessionId)
    // A closed session has nobody to tell and nothing to resync to.
    this.#droppedPerSession.delete(sessionId)
  }

  get droppedWhileDetached(): number {
    return this.#droppedWhileDetached
  }

  #nextFor(sessionId: string): number {
    const next = (this.#sequences.get(sessionId) ?? 0) + 1
    this.#sequences.set(sessionId, next)
    return next
  }

  /**
   * The bounded pending queue covers both a detached renderer and a connected
   * renderer that has spent its delivery credit. Breaching the cap discards
   * rather than grows: at that point a snapshot is both cheaper and more
   * correct than a replay the renderer cannot keep up with.
   */
  #buffer(envelope: EventEnvelope): void {
    const bytes = estimateBytes(envelope)
    if (this.#pendingBytes + bytes > MAX_QUEUED_SESSION_BYTES) {
      this.#droppedWhileDetached += this.#pending.length - this.#pendingHead
      // The envelope that broke the cap is dropped along with the buffer. It is
      // counted too: a discard that under-reports by one is still a lie.
      if (envelope.sessionId !== undefined) this.#droppedWhileDetached += 1
      // Which sessions lost something, not just how much was lost. A gap is
      // repaired per session, because a snapshot is per session.
      for (const dropped of [...this.#pending.slice(this.#pendingHead).map((item) => item.envelope), envelope]) {
        if (dropped.sessionId === undefined) continue
        this.#droppedPerSession.set(dropped.sessionId, (this.#droppedPerSession.get(dropped.sessionId) ?? 0) + 1)
      }
      this.#pending = []
      this.#pendingHead = 0
      this.#pendingBytes = 0
      if (this.#port !== undefined) this.#announceGaps()
      return
    }
    this.#pending.push({ envelope, bytes })
    this.#pendingBytes += bytes
  }

  #drain(): void {
    const port = this.#port
    if (port === undefined) return
    while (this.#pendingHead < this.#pending.length) {
      const next = this.#pending[this.#pendingHead]!
      if (this.#inFlightBytes > 0 && this.#inFlightBytes + next.bytes > EVENT_DELIVERY_WINDOW_BYTES) {
        if (this.#pendingHead >= 1_024 && this.#pendingHead * 2 >= this.#pending.length) {
          this.#pending = this.#pending.slice(this.#pendingHead)
          this.#pendingHead = 0
        }
        return
      }
      this.#pendingHead += 1
      this.#pendingBytes -= next.bytes
      this.#inFlight.push(next.bytes)
      this.#inFlightBytes += next.bytes
      port.postMessage(next.envelope)
    }
    this.#pending = []
    this.#pendingHead = 0
  }

  #acknowledge(count: number): void {
    for (let index = 0; index < count; index += 1) {
      const bytes = this.#inFlight[this.#inFlightHead]
      if (bytes === undefined) break
      this.#inFlightHead += 1
      this.#inFlightBytes -= bytes
    }
    if (this.#inFlightHead === this.#inFlight.length) {
      this.#inFlight = []
      this.#inFlightHead = 0
    } else if (this.#inFlightHead >= 1_024 && this.#inFlightHead * 2 >= this.#inFlight.length) {
      this.#inFlight = this.#inFlight.slice(this.#inFlightHead)
      this.#inFlightHead = 0
    }
    this.#drain()
  }

  /**
   * Says what was lost, then asks for it to be repaired.
   *
   * Order matters twice. `stream_gap` goes first so the renderer is told history
   * is incomplete before the snapshot that makes it complete again — a snapshot
   * arriving with no explanation looks like a timeline that jumped for no
   * reason. And the map is cleared before the handler runs, because the handler
   * emits, and an emission that overflowed again would otherwise be lost to the
   * iteration it is mutating.
   */
  #announceGaps(): ReadonlySet<string> {
    const gaps = [...this.#droppedPerSession]
    this.#droppedPerSession.clear()
    for (const [sessionId, droppedEvents] of gaps) {
      this.emit("stream_gap", { sessionId, droppedEvents }, sessionId)
      this.#onGap?.(sessionId, droppedEvents)
    }
    return new Set(gaps.map(([sessionId]) => sessionId))
  }
}

/**
 * Roughly what the envelope costs the delivery window, in bytes.
 *
 * A block delta is the one envelope on the token path — hundreds to thousands
 * per turn — and it takes the arithmetic branch, because serializing it here
 * would allocate a copy of every token the model produces purely to measure it.
 * That is the allocation the streaming rule forbids. Its shape is fixed and its
 * only unbounded field is the delta, so a constant plus that field's length is
 * the same number the serializer would have reached, to within the framing this
 * window does not need to be exact about.
 *
 * Everything else is structural and arrives at human rates, where walking the
 * value is free and being exact is worth more.
 */
const DELTA_FRAME_BYTES = 160

const estimateBytes = (envelope: EventEnvelope): number => {
  if (envelope.name === "block_delta") {
    const { textDelta } = envelope.payload as EventPayload<"block_delta">
    return DELTA_FRAME_BYTES + Buffer.byteLength(textDelta, "utf8")
  }
  try {
    const serialized = JSON.stringify(envelope)
    return serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8")
  } catch {
    return 0
  }
}
