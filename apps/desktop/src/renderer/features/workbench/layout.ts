/**
 * How the workbench occupies a window of a given width.
 *
 * The grid is three tracks above 1200px, two above 960, and one below that —
 * matching the media queries in `Workbench.tsx`. Those queries cannot read
 * this module (StyleX folds only literals), so the numbers are written twice
 * and `layout.test.ts` holds them together.
 *
 * Rail widths are a person's preference. A shrinking window must not honour a
 * preference the window can no longer show: two rails plus 480px of
 * conversation can exceed a laptop that was wide a moment ago. Fitting is a
 * display concern, not a write — the remembered widths stay put, so widening
 * the window restores what the person asked for rather than what the last
 * squeeze allowed.
 */

export const BREAKPOINT_FILES = 960
export const BREAKPOINT_ACTIVITY = 1200
export const MIN_CONVERSATION = 480

export const RAIL_FILES = { min: 200, max: 420 } as const
export const RAIL_ACTIVITY = { min: 240, max: 480 } as const

export interface RailLimits {
  min: number
  max: number
}

export interface ColumnFit {
  files: number
  activity: number
  filesInGrid: boolean
  activityInGrid: boolean
}

export interface RailWidths {
  files: number
  activity: number
}

/**
 * The untouched rail widths, scaled around the 1440px layout they were drawn
 * for and snapped to the interface's four-pixel geometry.
 *
 * These are defaults, not constraints. A person's remembered drag remains an
 * exact pixel width; only a rail that has never been resized follows the
 * window. The narrower caps keep both rails legible near their docking
 * breakpoints, while the wider caps spend some of a large display on filenames
 * and diagnostics instead of leaving all of it as empty conversation gutter.
 */
export const preferredRailWidths = (
  innerWidth: number,
  base: RailWidths,
): RailWidths => {
  const scaled = (value: number): number => Math.round((value * innerWidth / 1440) / 4) * 4
  return {
    files: Math.min(320, Math.max(232, scaled(base.files))),
    activity: Math.min(360, Math.max(264, scaled(base.activity))),
  }
}

/** Which rails still occupy a grid track at this window width. */
export const railsInGrid = (innerWidth: number): { files: boolean; activity: boolean } => ({
  files: innerWidth > BREAKPOINT_FILES,
  activity: innerWidth > BREAKPOINT_ACTIVITY,
})

export const clampWant = (want: number, limits: RailLimits): number =>
  Math.min(limits.max, Math.max(limits.min, want))

/**
 * A single rail, fitted against whatever else is still in the grid.
 *
 * The overlayed rail at a folded breakpoint is not "else": it is drawn over
 * the conversation rather than beside it, so it must not steal from the
 * budget. Dragging uses this; the window-level fit uses `fitColumns` so two
 * rails that both overflow shrink together rather than whichever was asked
 * first.
 */
export const fitRail = (
  want: number,
  limits: RailLimits,
  otherInGrid: number,
  innerWidth: number,
): number => Math.max(limits.min, Math.min(want, limits.max, innerWidth - otherInGrid - MIN_CONVERSATION))

/** Both rails, sharing one conversation floor, at one window width. */
export const fitColumns = (filesWant: number, activityWant: number, innerWidth: number): ColumnFit => {
  const filesInGrid = innerWidth > BREAKPOINT_FILES
  const activityInGrid = innerWidth > BREAKPOINT_ACTIVITY
  let files = clampWant(filesWant, RAIL_FILES)
  let activity = clampWant(activityWant, RAIL_ACTIVITY)

  const usedFiles = filesInGrid ? files : 0
  const usedActivity = activityInGrid ? activity : 0
  const overflow = usedFiles + usedActivity + MIN_CONVERSATION - innerWidth
  if (overflow > 0) {
    const shrinkFiles = filesInGrid ? files - RAIL_FILES.min : 0
    const shrinkActivity = activityInGrid ? activity - RAIL_ACTIVITY.min : 0
    const shrinkable = shrinkFiles + shrinkActivity
    if (shrinkable > 0) {
      const cut = Math.min(overflow, shrinkable)
      const filesCut = Math.round(cut * (shrinkFiles / shrinkable))
      if (filesInGrid) files -= filesCut
      if (activityInGrid) activity -= cut - filesCut
    }
  }

  return { files, activity, filesInGrid, activityInGrid }
}
