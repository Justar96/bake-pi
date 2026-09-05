export const LARGE_SESSION_BLOCKS = 10_000
export const MAX_DROPPED_FRAME_PERCENT = 1
export const MAX_FRAME_MS = 100
export const MAX_RENDERER_WORKING_SET_KIB = 600 * 1024

export interface RendererFrameProbe {
  blockCount: number
  loadFrameIntervalsMs: number[]
  frameIntervalsMs: number[]
  mountedRows: number
  lastVirtualIndex: number
}

/**
 * Samples through a painted end boundary, not just a DOM-ready assertion.
 *
 * A rAF callback can run after a long task but still carry the timestamp from
 * before it. Its successor reports that missed time. Stopping synchronously
 * when rows enter the DOM therefore hid the load's longest frame depending on
 * when the driver's next evaluation landed. Drain two rendering opportunities
 * after stop is requested, then resolve an array that will no longer change.
 *
 * Kept self-contained because the journey injects this function into Chromium;
 * the injected frame driver also lets unit tests reproduce the ordering exactly.
 */
export const startFrameProbe = (
  requestFrame: (callback: (now: number) => void) => void,
  onFrame?: (now: number) => void,
): { stop: () => Promise<number[]> } => {
  const intervals: number[] = []
  let previous: number | undefined
  let remaining: number | undefined
  let stopped: Promise<number[]> | undefined
  let finish: ((intervals: number[]) => void) | undefined
  const frame = (now: number): void => {
    onFrame?.(now)
    if (previous !== undefined) intervals.push(now - previous)
    previous = now
    if (remaining !== undefined && --remaining === 0) {
      finish!(intervals)
      return
    }
    requestFrame(frame)
  }
  requestFrame(frame)
  return {
    stop: () => {
      if (stopped === undefined) {
        remaining = 2
        stopped = new Promise((resolve) => { finish = resolve })
      }
      return stopped
    },
  }
}

export interface FrameSummary {
  cadenceMs: number
  frames: number
  dropped: number
  droppedPercent: number
  longestMs: number
}

/**
 * Turns requestAnimationFrame intervals into missed refresh opportunities.
 *
 * The display cadence is the twentieth percentile rather than a hard-coded
 * 16.7 ms: the named machine may run its panel at 60, 120, or 144 Hz. Long
 * frames cannot pull that estimate upward, while using the single fastest
 * interval would let one early callback exaggerate every later miss.
 */
export const summarizeFrames = (intervals: readonly number[]): FrameSummary => {
  const valid = intervals.filter((value) => Number.isFinite(value) && value > 0)
  if (valid.length < 10) throw new Error(`the renderer reported only ${String(valid.length)} frame intervals`)

  const ordered = [...valid].sort((left, right) => left - right)
  const cadenceMs = ordered[Math.floor((ordered.length - 1) * 0.2)]!
  let frames = 0
  let dropped = 0
  for (const interval of valid) {
    const opportunities = Math.max(1, Math.round(interval / cadenceMs))
    frames += opportunities
    dropped += opportunities - 1
  }

  return {
    cadenceMs,
    frames,
    dropped,
    droppedPercent: dropped / frames * 100,
    longestMs: Math.max(...valid),
  }
}
