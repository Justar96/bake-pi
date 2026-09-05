export const EFFORT_FRAME_WIDTH = 22
export const EFFORT_FRAME_GAP = 2
export const EFFORT_FRAME_PITCH = EFFORT_FRAME_WIDTH + EFFORT_FRAME_GAP

export const effortStripWidth = (count: number): number =>
  count <= 0 ? 0 : count * EFFORT_FRAME_WIDTH + (count - 1) * EFFORT_FRAME_GAP

export const effortPointerPosition = (clientX: number, stripLeft: number, count: number): number => {
  if (count <= 1) return 0
  const position = (clientX - stripLeft - EFFORT_FRAME_WIDTH / 2) / EFFORT_FRAME_PITCH
  return Math.max(0, Math.min(count - 1, position))
}

export const nearestEffortFrame = (position: number, count: number): number =>
  Math.max(0, Math.min(count - 1, Math.round(position)))

/** Neighbours move too, but less: the cursor pulls a small local wave through the strip. */
export const effortFrameScale = (frame: number, position: number): number => {
  const proximity = Math.max(0, 1 - Math.abs(frame - position) / 1.5)
  return 1 + proximity * 0.16
}

export const effortTimecode = (frame: number): string => `00:00:${String(frame).padStart(2, "0")}`

export const effortFrameForKey = (current: number, key: string, count: number): number | undefined => {
  if (key === "ArrowLeft" || key === "ArrowDown") return Math.max(0, current - 1)
  if (key === "ArrowRight" || key === "ArrowUp") return Math.min(count - 1, current + 1)
  if (key === "Home") return 0
  if (key === "End") return count - 1
  return undefined
}

export interface SpringFrame {
  position: number
  velocity: number
}

/** The traditional spring from the motion scale: mass 1, stiffness 100, damping 10. */
export const stepEffortSpring = (frame: SpringFrame, target: number, seconds: number): SpringFrame => {
  const acceleration = -100 * (frame.position - target) - 10 * frame.velocity
  const velocity = frame.velocity + acceleration * seconds
  return { position: frame.position + velocity * seconds, velocity }
}
