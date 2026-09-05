import type { EventPayload } from "@bake-pi/contract"
import type { StreamEvent } from "./stream.ts"

export interface AnimationFrameDriver {
  request: (callback: () => void) => number
  cancel: (frame: number) => void
}

/** Keeps one paint's retained streamed text bounded even when painting stalls. */
export const MAX_BATCHED_DELTA_CHARACTERS = 256 * 1024

const browserFrames = (): AnimationFrameDriver => ({
  request: (callback) => window.requestAnimationFrame(callback),
  cancel: (frame) => window.cancelAnimationFrame(frame),
})

type BlockDeltaEvent = StreamEvent<"block_delta">

const isBlockDelta = (event: StreamEvent): event is BlockDeltaEvent => event.name === "block_delta"

const sameBlock = (left: BlockDeltaEvent, right: BlockDeltaEvent): boolean =>
  left.sessionId === right.sessionId &&
  left.payload.messageId === right.payload.messageId &&
  left.payload.blockIndex === right.payload.blockIndex

/**
 * Folds adjacent text deltas before they reach the immutable session reducer.
 *
 * Ordering is the contract here: a structural event first drains every delta
 * before it, so a block finish or snapshot can never overtake streamed text.
 * Only adjacent deltas for the exact same block merge; interleaved sessions or
 * blocks remain in their original order.
 */
export class StreamBatcher {
  readonly #deliver: (event: StreamEvent) => void
  readonly #frames: AnimationFrameDriver
  #pending: StreamEvent[] = []
  #pendingCharacters = 0
  #frame: number | undefined

  constructor(deliver: (event: StreamEvent) => void, frames: AnimationFrameDriver = browserFrames()) {
    this.#deliver = deliver
    this.#frames = frames
  }

  push(event: StreamEvent): void {
    if (!isBlockDelta(event)) {
      this.flush()
      this.#deliver(event)
      return
    }

    const characters = event.payload.textDelta.length
    if (characters > MAX_BATCHED_DELTA_CHARACTERS) {
      this.flush()
      this.#deliver(event)
      return
    }
    if (this.#pendingCharacters + characters > MAX_BATCHED_DELTA_CHARACTERS) this.flush()

    const previous = this.#pending.at(-1)
    if (previous !== undefined && isBlockDelta(previous) && sameBlock(previous, event)) {
      const payload: EventPayload<"block_delta"> = {
        ...event.payload,
        textDelta: previous.payload.textDelta + event.payload.textDelta,
      }
      this.#pending[this.#pending.length - 1] = { ...event, payload }
    } else {
      this.#pending.push(event)
    }
    this.#pendingCharacters += characters
    this.#schedule()
  }

  flush(): void {
    if (this.#frame !== undefined) {
      this.#frames.cancel(this.#frame)
      this.#frame = undefined
    }
    this.#drain()
  }

  #schedule(): void {
    if (this.#frame !== undefined) return
    this.#frame = this.#frames.request(() => {
      this.#frame = undefined
      this.#drain()
    })
  }

  #drain(): void {
    const pending = this.#pending
    this.#pending = []
    this.#pendingCharacters = 0
    for (const event of pending) this.#deliver(event)
  }
}
