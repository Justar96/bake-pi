import { describe, expect, test } from "bun:test"
import { Virtualizer } from "@tanstack/react-virtual"
import { initialTimelineOffset } from "./timeline-follow.ts"

const timeline = (count: number, estimateSize: (index: number) => number) => new Virtualizer<HTMLDivElement, HTMLDivElement>({
  count,
  estimateSize,
  initialOffset: () => initialTimelineOffset(count, estimateSize),
  initialRect: { width: 900, height: 600 },
  getScrollElement: () => null,
  observeElementRect: () => undefined,
  observeElementOffset: () => undefined,
  scrollToFn: () => {},
  anchorTo: "end",
  overscan: 5,
})

describe("tail-first timeline initialization", () => {
  test("uses the same mixed row estimates as the virtualizer", () => {
    const sizes = [32, 150, 32, 150]
    const visited: number[] = []
    expect(initialTimelineOffset(sizes.length, (index) => {
      visited.push(index)
      return sizes[index]!
    })).toBe(364)
    expect(visited).toEqual([0, 1, 2, 3])
  })

  test("a 10,000-row timeline starts at its tail without rendering its head", () => {
    const view = timeline(10_000, () => 150)
    const rows = view.getVirtualItems()
    expect(rows[0]!.index).toBeGreaterThanOrEqual(9_990)
    expect(rows.at(-1)!.index).toBe(9_999)
    expect(rows.length).toBeLessThan(50)
  })

  test("short and empty timelines still render all available rows", () => {
    expect(timeline(3, () => 150).getVirtualItems().map((row) => row.index)).toEqual([0, 1, 2])
    expect(timeline(0, () => 150).getVirtualItems()).toEqual([])
    expect(initialTimelineOffset(0, () => { throw new Error("no row exists") })).toBe(0)
  })

  test("initialization does not rerun when a detached reader receives an append", () => {
    const view = timeline(10_000, () => 150)
    view.getVirtualItems()
    // scrollOffset is the virtualizer's public position. The viewport is not
    // attached here; the real journey covers the wheel and DOM halves.
    view.scrollOffset = 1_200
    view.setOptions({ ...view.options, count: 10_001, initialOffset: () => {
      throw new Error("an append must not reapply the initial offset")
    } })
    const rows = view.getVirtualItems()
    expect(rows.some((row) => row.index === 8)).toBe(true)
    expect(view.scrollOffset).toBe(1_200)
  })
})
