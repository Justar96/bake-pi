import { describe, expect, test } from "bun:test"
import { CONTEXT_RAMP_STOPS, composerIsDense, contextRampStop, readContext } from "./composer-layout.ts"

describe("responsive composer layout", () => {
  test("goes dense only once the column is narrow, and never before it is measured", () => {
    expect(composerIsDense(800)).toBe(false)
    expect(composerIsDense(559)).toBe(true)
    expect(composerIsDense(0)).toBe(false)
  })

  test("reads the context window as a rounded percentage and an exact fraction", () => {
    expect(readContext({ usedTokens: 12_345, maxTokens: 200_000 })).toMatchObject({ percent: 6, fraction: 0.061725, pressure: "calm" })
    expect(readContext({ usedTokens: 100_000, maxTokens: 200_000 })).toMatchObject({ percent: 50, fraction: 0.5 })
  })

  /**
   * A model that reports no threshold still has to change colour somewhere, and
   * one that reports a low threshold has to change colour there rather than at
   * a percentage picked here.
   */
  test("takes its pressure from the reported threshold, and from three quarters without one", () => {
    expect(readContext({ usedTokens: 160_000, maxTokens: 200_000 }).pressure).toBe("pressing")
    expect(readContext({ usedTokens: 120_000, maxTokens: 200_000 }).pressure).toBe("calm")
    expect(readContext({ usedTokens: 120_000, maxTokens: 200_000, compactionThresholdTokens: 100_000 }).pressure).toBe("pressing")
    expect(readContext({ usedTokens: 190_000, maxTokens: 200_000 }).pressure).toBe("critical")
  })

  /**
   * The fraction is a dash offset subtracted from a circumference, so a reading
   * past full would draw the arc backwards out of its own start, and a window
   * the model has not sized yet must read as empty rather than as NaN.
   */
  test("keeps the fraction inside the circle it is drawn on", () => {
    expect(readContext({ usedTokens: 300_000, maxTokens: 200_000 })).toMatchObject({ percent: 100, fraction: 1 })
    expect(readContext({ usedTokens: 0, maxTokens: 0 })).toMatchObject({ percent: 0, fraction: 0 })
  })

})

/**
 * The ring's colour is a second reading of the same number, so what is worth
 * asserting is that it agrees with the first: cool at empty, the middle stop
 * where the word turns amber, the last stop at full — for a model that
 * compacts where the fallback does and for one that compacts at half.
 */
describe("the context ring warms with the window", () => {
  const warmth = (usedTokens: number, maxTokens: number, compactionThresholdTokens?: number): number =>
    readContext({ usedTokens, maxTokens, ...(compactionThresholdTokens === undefined ? {} : { compactionThresholdTokens }) }).warmth

  test("is anchored on the threshold, wherever the model puts it", () => {
    expect(warmth(0, 200_000)).toBe(0)
    expect(warmth(150_000, 200_000)).toBe(0.5)
    expect(warmth(200_000, 200_000)).toBe(1)
    expect(warmth(100_000, 200_000, 100_000)).toBe(0.5)
    expect(warmth(150_000, 200_000, 100_000)).toBe(0.75)
  })

  test("never leaves the ramp, whatever the model reports", () => {
    for (const [used, max, threshold] of [
      [0, 0, undefined],
      [300_000, 200_000, undefined],
      [10, 200_000, 0],
      [10, 200_000, 200_000],
      [199_999, 200_000, 200_000],
    ] as const) {
      const stop = contextRampStop(warmth(used, max, threshold))
      expect({ used, threshold, ok: Number.isInteger(stop) && stop >= 0 && stop < CONTEXT_RAMP_STOPS })
        .toEqual({ used, threshold, ok: true })
    }
  })

  test("climbs one way, and turns amber where the word does", () => {
    const stops = [0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 1].map(contextRampStop)
    expect(stops).toEqual([...stops].sort((a, b) => a - b))
    expect(contextRampStop(0)).toBe(0)
    // The middle stop is `warning`, and it is reached at the threshold rather
    // than at a percentage of the window.
    expect(contextRampStop(0.5)).toBe(5)
    expect(contextRampStop(1)).toBe(CONTEXT_RAMP_STOPS - 1)
  })
})
