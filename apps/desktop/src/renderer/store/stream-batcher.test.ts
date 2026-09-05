import { describe, expect, test } from "bun:test"
import { MAX_BATCHED_DELTA_CHARACTERS, StreamBatcher, type AnimationFrameDriver } from "./stream-batcher.ts"
import type { StreamEvent } from "./stream.ts"

const SESSION = "00000000-0000-4000-8000-000000000001"

class Frames implements AnimationFrameDriver {
  #next = 1
  readonly callbacks = new Map<number, () => void>()

  request(callback: () => void): number {
    const frame = this.#next++
    this.callbacks.set(frame, callback)
    return frame
  }

  cancel(frame: number): void {
    this.callbacks.delete(frame)
  }

  paint(): void {
    const callbacks = [...this.callbacks.values()]
    this.callbacks.clear()
    for (const callback of callbacks) callback()
  }
}

const delta = (
  textDelta: string,
  sequence: number,
  messageId = "m0",
  blockIndex = 0,
  sessionId: string | undefined = SESSION,
): StreamEvent<"block_delta"> => ({
  name: "block_delta",
  sequence,
  sessionId,
  payload: { messageId, blockIndex, textDelta },
})

const structural = (sequence: number): StreamEvent<"block_finished"> => ({
  name: "block_finished",
  sequence,
  sessionId: SESSION,
  payload: { messageId: "m0", block: { index: 0, kind: "text", text: "finished" } },
})

describe("StreamBatcher", () => {
  test("coalesces adjacent deltas for one block into one reducer update per paint", () => {
    const frames = new Frames()
    const delivered: StreamEvent[] = []
    const batcher = new StreamBatcher((event) => delivered.push(event), frames)

    batcher.push(delta("one", 1))
    batcher.push(delta(" two", 2))
    batcher.push(delta(" three", 3))

    expect(delivered).toEqual([])
    expect(frames.callbacks.size).toBe(1)
    frames.paint()
    expect(delivered).toEqual([delta("one two three", 3)])
  })

  test("preserves interleaved block order", () => {
    const frames = new Frames()
    const delivered: StreamEvent[] = []
    const batcher = new StreamBatcher((event) => delivered.push(event), frames)

    batcher.push(delta("a", 1, "m0"))
    batcher.push(delta("b", 2, "m1"))
    batcher.push(delta("c", 3, "m0"))
    frames.paint()

    expect(delivered).toEqual([delta("a", 1, "m0"), delta("b", 2, "m1"), delta("c", 3, "m0")])
  })

  test("drains deltas before a structural event", () => {
    const frames = new Frames()
    const delivered: StreamEvent[] = []
    const batcher = new StreamBatcher((event) => delivered.push(event), frames)

    batcher.push(delta("one", 1))
    batcher.push(delta(" two", 2))
    batcher.push(structural(3))

    expect(delivered).toEqual([delta("one two", 2), structural(3)])
    expect(frames.callbacks.size).toBe(0)
  })

  test("flushes before one paint can retain more than the hard cap", () => {
    const frames = new Frames()
    const delivered: StreamEvent[] = []
    const batcher = new StreamBatcher((event) => delivered.push(event), frames)
    const first = "a".repeat(MAX_BATCHED_DELTA_CHARACTERS)

    batcher.push(delta(first, 1))
    batcher.push(delta("b", 2))

    expect(delivered).toEqual([delta(first, 1)])
    frames.paint()
    expect(delivered.at(-1)).toEqual(delta("b", 2))
  })
})
