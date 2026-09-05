import { describe, expect, test } from "bun:test"
import { startFrameProbe, summarizeFrames } from "./frame-budget.ts"

describe("renderer frame probe boundaries", () => {
  const frames = () => {
    let pending: ((now: number) => void) | undefined
    return {
      request: (callback: (now: number) => void): void => {
        expect(pending).toBeUndefined()
        pending = callback
      },
      advance: (now: number): void => {
        const callback = pending
        pending = undefined
        expect(callback).toBeDefined()
        callback!(now)
      },
      pending: (): boolean => pending !== undefined,
    }
  }

  test("keeps the delayed frame that arrives after the DOM is ready", async () => {
    const driver = frames()
    const probe = startFrameProbe(driver.request)
    driver.advance(0)
    driver.advance(6)
    let finished = false
    const stopping = probe.stop().then((intervals) => { finished = true; return intervals })

    // rAF's timestamp is the rendering opportunity, not the instant its
    // callback runs. The next callback can run after a long task while still
    // carrying the old timestamp; the following callback exposes the delay.
    driver.advance(12)
    await Promise.resolve()
    expect(finished).toBe(false)
    driver.advance(121)

    expect(await stopping).toEqual([6, 6, 109])
    expect(driver.pending()).toBe(false)
  })

  test("stopping twice shares the same boundary and does not restart sampling", async () => {
    const driver = frames()
    const probe = startFrameProbe(driver.request)
    driver.advance(0)
    const first = probe.stop()
    expect(probe.stop()).toBe(first)
    driver.advance(6)
    driver.advance(12)
    expect(await first).toEqual([6, 6])
    expect(probe.stop()).toBe(first)
    expect(driver.pending()).toBe(false)
  })
})

describe("renderer frame accounting", () => {
  test("adapts to the display cadence without inventing dropped frames", () => {
    const summary = summarizeFrames([8.2, 8.4, 8.3, 8.3, 8.4, 8.2, 8.3, 8.3, 8.4, 8.3])

    expect(summary.cadenceMs).toBe(8.2)
    expect(summary.frames).toBe(10)
    expect(summary.dropped).toBe(0)
    expect(summary.droppedPercent).toBe(0)
  })

  test("counts missed refresh opportunities rather than slow callbacks", () => {
    const summary = summarizeFrames([16.5, 16.7, 16.6, 16.7, 16.6, 16.7, 16.6, 16.7, 50, 101])

    expect(summary.cadenceMs).toBe(16.6)
    expect(summary.frames).toBe(17)
    expect(summary.dropped).toBe(7)
    expect(summary.droppedPercent).toBeCloseTo(41.176, 3)
    expect(summary.longestMs).toBe(101)
  })

  test("refuses a sample too short to establish a cadence", () => {
    expect(() => summarizeFrames([16.7, 16.7])).toThrow("only 2 frame intervals")
  })
})
