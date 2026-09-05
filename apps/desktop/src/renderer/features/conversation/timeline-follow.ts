/**
 * The virtualizer's initial scroll target, before any row has a measured DOM
 * height. Use its own estimates rather than a second row-height policy. The
 * browser clamps this content-end target to its viewport; normal following
 * handles later measurements. Only the initialOffset callback should call it,
 * so an append cannot drag a reader who has since scrolled away from the end.
 */
export const initialTimelineOffset = (count: number, estimateSize: (index: number) => number): number => {
  let offset = 0
  for (let index = 0; index < count; index += 1) offset += estimateSize(index)
  return offset
}

export interface TimelineMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/**
 * Browser layout is allowed to leave scroll metrics on fractional pixels.
 * Two pixels absorbs that rounding without turning "I moved up a little" into
 * permission to drag the reader back down on the next streamed block.
 */
const END_TOLERANCE = 2

export const distanceFromTimelineEnd = ({ scrollTop, scrollHeight, clientHeight }: TimelineMetrics): number =>
  Math.max(0, scrollHeight - clientHeight - scrollTop)

export const isTimelineAtEnd = (metrics: TimelineMetrics): boolean =>
  distanceFromTimelineEnd(metrics) <= END_TOLERANCE

export const isTimelineAtStart = ({ scrollTop }: Pick<TimelineMetrics, "scrollTop">): boolean =>
  scrollTop <= END_TOLERANCE

/**
 * A scroll event describes geometry, not authorship: virtualizer measurement
 * and browser anchoring can emit one without a wheel, key, or pointer. Once a
 * reader detaches, reaching the end naturally resumes following; while already
 * following, only an explicit upward input is allowed to revoke that intent.
 *
 * The conversation log and a running command's listing both use this, because
 * a streamed chunk growing the box is the same kind of non-event as a
 * virtualizer measuring a row.
 */
export const followingAfterTimelineScroll = (following: boolean, metrics: TimelineMetrics): boolean =>
  following || isTimelineAtEnd(metrics)

/** Overflow the listing can actually move, so a wheel belongs to it rather than to the conversation. */
export const listingCanScroll = ({ scrollHeight, clientHeight }: Pick<TimelineMetrics, "scrollHeight" | "clientHeight">): boolean =>
  scrollHeight > clientHeight

/**
 * A nested listing keeps the wheel only while it can still move that way.
 * At either edge the gesture belongs to the conversation, otherwise the
 * cursor is trapped in the listing — a deadlock with the log underneath.
 */
export const listingConsumesWheel = (deltaY: number, metrics: TimelineMetrics): boolean => {
  if (!listingCanScroll(metrics)) return false
  if (deltaY > 0) return !isTimelineAtEnd(metrics)
  if (deltaY < 0) return !isTimelineAtStart(metrics)
  return false
}

/** Only an upward wheel this box can still absorb is a request to stop following. */
export const shouldDetachFollowOnWheel = (deltaY: number, metrics: TimelineMetrics): boolean =>
  deltaY < 0 && listingConsumesWheel(deltaY, metrics)
