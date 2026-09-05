import { BakePiError, type EventName, type EventPayload, MAX_EVENT_ACK_COUNT, acceptEvent } from "@bake-pi/contract"

export interface StreamEvent<N extends EventName = EventName> {
  name: N
  sequence: number
  sessionId: string | undefined
  payload: EventPayload<N>
}

export type StreamListener = (event: StreamEvent) => void

/**
 * The renderer's intake, and the only place the sequence fence lives.
 *
 * The rule, stated once so no feature reimplements it:
 *
 *   A snapshot carries the sequence it was taken at. On receiving one, replace
 *   the projection and treat its sequence as a fence: discard any later replay
 *   at or below that sequence, and apply only events above it.
 *
 * That is what makes events arriving *during* snapshot construction neither
 * lost nor applied twice. Getting it wrong produces a timeline that is subtly
 * wrong rather than obviously broken — a duplicated tool result, a message that
 * reappears — which is exactly the kind of bug that survives manual testing.
 */
export class EventStream {
  #port: MessagePort | undefined
  #listeners = new Set<StreamListener>()
  #lastSequence = new Map<string, number>()
  /** Sessions a gap has already been reported for, until a snapshot re-fences them. */
  #awaitingResync = new Set<string>()
  #onGap: ((sessionId: string, dropped: number) => void) | undefined
  #pendingAcks = 0
  #ackTimer: ReturnType<typeof setTimeout> | undefined

  connect(port: MessagePort): void {
    this.#flushAcks()
    this.#port?.close()
    this.#port = port
    port.onmessage = (message: MessageEvent) => {
      try {
        this.#receive(message.data)
      } finally {
        this.#queueAck()
      }
    }
    port.start()
  }

  disconnect(): void {
    this.#flushAcks()
    this.#port?.close()
    this.#port = undefined
    this.#lastSequence.clear()
    this.#awaitingResync.clear()
  }

  #queueAck(): void {
    this.#pendingAcks += 1
    if (this.#ackTimer !== undefined) return
    this.#ackTimer = setTimeout(() => this.#flushAcks(), 0)
  }

  #flushAcks(): void {
    if (this.#ackTimer !== undefined) clearTimeout(this.#ackTimer)
    this.#ackTimer = undefined
    const port = this.#port
    while (port !== undefined && this.#pendingAcks > 0) {
      const count = Math.min(this.#pendingAcks, MAX_EVENT_ACK_COUNT)
      port.postMessage({ kind: "event_ack", count })
      this.#pendingAcks -= count
    }
  }

  subscribe(listener: StreamListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /**
   * Called once per gap, with how many events went missing.
   *
   * Once per gap rather than once per event that follows it: the handler asks
   * the host for a snapshot, and a stream that lost an event mid-turn would
   * otherwise ask again for every delta until the answer arrived. The flag
   * clears when a snapshot re-fences the session.
   */
  onGap(handler: (sessionId: string, dropped: number) => void): void {
    this.#onGap = handler
  }

  #receive(raw: unknown): void {
    let event: StreamEvent
    try {
      const accepted = acceptEvent(raw)
      event = {
        name: accepted.name,
        sequence: accepted.sequence,
        sessionId: accepted.sessionId,
        payload: accepted.payload as EventPayload<EventName>,
      }
    } catch (error) {
      // The host is the trusted side of this channel, so a malformed event is a
      // bug rather than an attack — but it is still not something to apply. It
      // is dropped, and the next snapshot repairs the projection.
      //
      // Only a schema rejection is droppable, and `acceptEvent` throws
      // `BakePiError` for every one of those. Anything else means the intake
      // itself is broken rather than the event: every event after it fails the
      // same way, including the snapshot that would repair the projection, and
      // even the gap counter stays silent because `#lastSequence` is only
      // written by an event that was accepted. A wider catch here once hid
      // exactly that — the schema compiler calling `new Function` under a
      // `script-src` that forbids it — for as long as it took to notice that
      // nothing streamed. So it goes to the renderer's uncaught-error surface
      // on the first event instead of blanking every session in silence.
      if (error instanceof BakePiError) return
      throw error
    }

    const sessionId = event.sessionId
    if (sessionId === undefined) {
      this.#dispatch(event)
      return
    }

    if (event.name === "session_snapshot") {
      // The fence. Everything at or below the snapshot's sequence is already
      // reflected in it and must not be applied again. Nothing is held back
      // waiting for it: the port delivers in order, so every event that predates
      // a snapshot arrives before it and is superseded by it.
      this.#lastSequence.set(sessionId, event.sequence)
      // Whatever was missing, this snapshot has it. Asking again would ask for
      // the answer we are holding.
      this.#awaitingResync.delete(sessionId)
      this.#dispatch(event)
      return
    }

    const last = this.#lastSequence.get(sessionId)
    if (last !== undefined && event.sequence <= last) return

    if (last !== undefined && event.sequence > last + 1) {
      // A sequence number that never arrived. On this side that means an event
      // the host sent and the schema check rejected — the host believes it
      // delivered, so nothing but this comparison will ever notice. The event in
      // hand is still applied: it is newer than the projection, and a reducer
      // that cannot place it drops it on its own. The snapshot is what actually
      // repairs the hole.
      this.#reportGap(sessionId, event.sequence - last - 1)
    }

    this.#lastSequence.set(sessionId, event.sequence)
    this.#dispatch(event)
  }

  #reportGap(sessionId: string, dropped: number): void {
    if (this.#awaitingResync.has(sessionId)) return
    this.#awaitingResync.add(sessionId)
    this.#onGap?.(sessionId, dropped)
  }

  #dispatch(event: StreamEvent): void {
    for (const listener of this.#listeners) listener(event)
  }
}
