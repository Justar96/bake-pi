import { describe, expect, test } from "bun:test"
import {
  EFFORT_FRAME_PITCH,
  EFFORT_FRAME_WIDTH,
  effortFrameForKey,
  effortFrameScale,
  effortPointerPosition,
  effortStripWidth,
  effortTimecode,
  nearestEffortFrame,
  stepEffortSpring,
} from "./effort-scrubber.ts"

describe("effort filmstrip geometry", () => {
  test("maps the pointer to frame centres and clamps outside the strip", () => {
    const left = 100
    expect(effortPointerPosition(left + EFFORT_FRAME_WIDTH / 2, left, 7)).toBe(0)
    expect(effortPointerPosition(left + EFFORT_FRAME_WIDTH / 2 + EFFORT_FRAME_PITCH * 3.4, left, 7)).toBeCloseTo(3.4)
    expect(effortPointerPosition(left - 50, left, 7)).toBe(0)
    expect(effortPointerPosition(left + 500, left, 7)).toBe(6)
  })

  test("keeps the strip width fixed while frames swell with transforms", () => {
    expect(effortStripWidth(7)).toBe(166)
    expect(effortFrameScale(3, 3)).toBeCloseTo(1.16)
    expect(effortFrameScale(2, 3)).toBeGreaterThan(1)
    expect(effortFrameScale(0, 3)).toBe(1)
  })

  test("settles and labels the nearest discrete frame", () => {
    expect(nearestEffortFrame(3.49, 7)).toBe(3)
    expect(nearestEffortFrame(3.5, 7)).toBe(4)
    expect(effortTimecode(4)).toBe("00:00:04")
  })
})

describe("effort filmstrip input", () => {
  test("steps by one frame and supports both ends", () => {
    expect(effortFrameForKey(3, "ArrowLeft", 7)).toBe(2)
    expect(effortFrameForKey(3, "ArrowRight", 7)).toBe(4)
    expect(effortFrameForKey(3, "Home", 7)).toBe(0)
    expect(effortFrameForKey(3, "End", 7)).toBe(6)
    expect(effortFrameForKey(3, "Enter", 7)).toBeUndefined()
  })

  test("the spring accelerates toward its target", () => {
    const next = stepEffortSpring({ position: 1.2, velocity: 0 }, 2, 0.016)
    expect(next.position).toBeGreaterThan(1.2)
    expect(next.velocity).toBeGreaterThan(0)
  })
})
