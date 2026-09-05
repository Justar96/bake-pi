import type { EventEmitter } from "./emitter.ts"

/**
 * Says which sessions the supervisor refused to bring back.
 *
 * The decision is main's — it is the only process that outlives a crash, so it
 * is the only one that can attribute one — but main cannot deliver it. It
 * creates the event `MessagePort`, hands one end to this process and the other
 * to the renderer, and keeps neither; that is what stops a streamed token from
 * relaying through the supervisor, and it means the supervisor has no voice on
 * the channel the renderer listens to. So the decision arrives here in the
 * handshake and is announced from here.
 *
 * Without this the renderer keeps a card for a session nothing is behind: its
 * events stop, no snapshot ever replaces it, and there is nothing to say why.
 */
export const announceQuarantine = (emitter: EventEmitter, sessionIds: readonly string[] | undefined): void => {
  for (const sessionId of sessionIds ?? []) {
    emitter.emit("session_disconnected", { sessionId, quarantined: true }, sessionId)
  }
}
