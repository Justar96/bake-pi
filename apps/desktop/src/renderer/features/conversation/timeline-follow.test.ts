import { describe, expect, test } from "bun:test"
import {
  distanceFromTimelineEnd,
  followingAfterTimelineScroll,
  isTimelineAtEnd,
  isTimelineAtStart,
  listingCanScroll,
  listingConsumesWheel,
  shouldDetachFollowOnWheel,
} from "./timeline-follow.ts"

describe("timeline bottom-follow policy", () => {
  test("treats the bottom and sub-pixel layout drift as pinned", () => {
    expect(distanceFromTimelineEnd({ scrollTop: 600, scrollHeight: 1_000, clientHeight: 400 })).toBe(0)
    expect(isTimelineAtEnd({ scrollTop: 598, scrollHeight: 1_000, clientHeight: 400 })).toBe(true)
  })

  test("stops following after any deliberate move away from the end", () => {
    expect(isTimelineAtEnd({ scrollTop: 597.99, scrollHeight: 1_000, clientHeight: 400 })).toBe(false)
    expect(isTimelineAtEnd({ scrollTop: 350, scrollHeight: 1_000, clientHeight: 400 })).toBe(false)
  })

  test("keeps fractional layout values stable at the threshold", () => {
    expect(isTimelineAtEnd({ scrollTop: 597.5, scrollHeight: 999.5, clientHeight: 400 })).toBe(true)
    expect(isTimelineAtEnd({ scrollTop: 597.49, scrollHeight: 999.5, clientHeight: 400 })).toBe(false)
  })

  test("never reports a negative distance when the browser clamps the scroll position", () => {
    expect(distanceFromTimelineEnd({ scrollTop: 610, scrollHeight: 1_000, clientHeight: 400 })).toBe(0)
  })

  test("layout scroll events preserve intent while a detached reader can resume at the end", () => {
    const awayFromEnd = { scrollTop: 600, scrollHeight: 1_200, clientHeight: 400 }
    expect(followingAfterTimelineScroll(true, awayFromEnd)).toBe(true)
    expect(followingAfterTimelineScroll(false, awayFromEnd)).toBe(false)
    expect(followingAfterTimelineScroll(false, { scrollTop: 800, scrollHeight: 1_200, clientHeight: 400 })).toBe(true)
  })
})

describe("command listing follow", () => {
  const overflowed = { scrollTop: 200, scrollHeight: 1_000, clientHeight: 320 }
  const fitting = { scrollTop: 0, scrollHeight: 200, clientHeight: 320 }
  const atStart = { scrollTop: 0, scrollHeight: 1_000, clientHeight: 320 }
  const atEnd = { scrollTop: 680, scrollHeight: 1_000, clientHeight: 320 }

  test("a listing that still fits the box yields the wheel to the conversation", () => {
    expect(listingCanScroll(fitting)).toBe(false)
    expect(listingConsumesWheel(-40, fitting)).toBe(false)
    expect(listingConsumesWheel(40, fitting)).toBe(false)
    expect(shouldDetachFollowOnWheel(-40, fitting)).toBe(false)
  })

  test("an overflowed listing keeps the wheel only while it can still move that way", () => {
    expect(listingCanScroll(overflowed)).toBe(true)
    expect(listingConsumesWheel(-40, overflowed)).toBe(true)
    expect(listingConsumesWheel(40, overflowed)).toBe(true)
    expect(shouldDetachFollowOnWheel(-40, overflowed)).toBe(true)
    expect(shouldDetachFollowOnWheel(40, overflowed)).toBe(false)
    expect(shouldDetachFollowOnWheel(0, overflowed)).toBe(false)
  })

  test("at either edge the listing yields, so the conversation is not deadlocked", () => {
    expect(isTimelineAtStart(atStart)).toBe(true)
    expect(listingConsumesWheel(-40, atStart)).toBe(false)
    expect(listingConsumesWheel(40, atStart)).toBe(true)
    expect(shouldDetachFollowOnWheel(-40, atStart)).toBe(false)
    expect(isTimelineAtEnd(atEnd)).toBe(true)
    expect(listingConsumesWheel(40, atEnd)).toBe(false)
    expect(listingConsumesWheel(-40, atEnd)).toBe(true)
  })
})

