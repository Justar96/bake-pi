import { expect, test } from "bun:test"

/**
 * A running command's listing has to follow the same pin policy as the
 * conversation: layout and programmatic scrolls are not a person, and a wheel
 * that the listing can consume must not detach the log behind it.
 */
const source = await Bun.file(new URL("./CodeBlock.tsx", import.meta.url)).text()
const timeline = await Bun.file(new URL("./Timeline.tsx", import.meta.url)).text()

test("command output follows with the shared pin policy, not geometry-from-scroll", () => {
  expect(source).toContain("followingAfterTimelineScroll")
  expect(source).toContain("shouldDetachFollowOnWheel")
  expect(source).not.toContain("scrollHeight - 8")
})

test("a listing keeps the wheel only while it can move, then yields to the conversation", () => {
  expect(source).toContain("listingConsumesWheel")
  expect(source).toContain("stopPropagation")
  expect(source).not.toContain("overscrollBehavior")
  expect(timeline).toContain("shouldDetachFollowOnWheel")
})

test("listings wear the same file icons as the tree", () => {
  expect(source).toContain("pickFileIcon")
  expect(source).toContain("FileIcon")
  expect(source).not.toContain("FileCode2")
})
