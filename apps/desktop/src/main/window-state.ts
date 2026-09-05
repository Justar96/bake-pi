import { readFile, writeFile } from "node:fs/promises"

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowDisplay {
  id: number
  workArea: WindowBounds
}

export interface StoredWindowState {
  version: 1
  bounds: WindowBounds
  displayId: number
  displayWorkArea: WindowBounds
  maximized: boolean
}

export interface WindowPlacement extends WindowBounds {
  minWidth: number
  minHeight: number
}

export const DEFAULT_WINDOW_SIZE = { width: 1280, height: 860 } as const
export const MIN_WINDOW_SIZE = { width: 720, height: 600 } as const

const finiteInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value)

const isBounds = (value: unknown): value is WindowBounds => {
  if (typeof value !== "object" || value === null) return false
  const bounds = value as Partial<WindowBounds>
  return finiteInteger(bounds.x)
    && finiteInteger(bounds.y)
    && finiteInteger(bounds.width)
    && finiteInteger(bounds.height)
    && bounds.width > 0
    && bounds.height > 0
}

const isWindowState = (value: unknown): value is StoredWindowState => {
  if (typeof value !== "object" || value === null) return false
  const state = value as Partial<StoredWindowState>
  return state.version === 1
    && isBounds(state.bounds)
    && finiteInteger(state.displayId)
    && isBounds(state.displayWorkArea)
    && typeof state.maximized === "boolean"
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value))

const intersectionArea = (a: WindowBounds, b: WindowBounds): number => {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  return width * height
}

/** Fits a normal window into one display's usable area, all measured in DIPs. */
export const fitWindowToWorkArea = (bounds: WindowBounds, workArea: WindowBounds): WindowPlacement => {
  const minWidth = Math.min(MIN_WINDOW_SIZE.width, workArea.width)
  const minHeight = Math.min(MIN_WINDOW_SIZE.height, workArea.height)
  const width = clamp(bounds.width, minWidth, workArea.width)
  const height = clamp(bounds.height, minHeight, workArea.height)
  return {
    x: clamp(bounds.x, workArea.x, workArea.x + workArea.width - width),
    y: clamp(bounds.y, workArea.y, workArea.y + workArea.height - height),
    width,
    height,
    minWidth,
    minHeight,
  }
}

/**
 * Restores a window without confusing physical pixels with Electron's DIPs.
 *
 * A matched display keeps the window's offset from that display's work area,
 * so rearranging monitors does not strand it at the old desktop coordinate.
 * If the display disappeared, an overlapping display wins; otherwise the
 * window is centred on the primary display instead of opening off-screen.
 */
export const resolveWindowPlacement = (
  state: StoredWindowState | undefined,
  displays: readonly WindowDisplay[],
  primaryDisplay: WindowDisplay,
): WindowPlacement => {
  const exact = state === undefined ? undefined : displays.find((display) => display.id === state.displayId)
  const overlap = state === undefined || exact !== undefined
    ? undefined
    : displays.reduce<WindowDisplay | undefined>((best, display) => {
      if (intersectionArea(state.bounds, display.workArea) === 0) return best
      if (best === undefined) return display
      return intersectionArea(state.bounds, display.workArea) > intersectionArea(state.bounds, best.workArea)
        ? display
        : best
    }, undefined)
  const target = exact ?? overlap ?? primaryDisplay

  if (state === undefined) {
    const width = Math.min(DEFAULT_WINDOW_SIZE.width, target.workArea.width)
    const height = Math.min(DEFAULT_WINDOW_SIZE.height, target.workArea.height)
    return fitWindowToWorkArea({
      x: target.workArea.x + Math.round((target.workArea.width - width) / 2),
      y: target.workArea.y + Math.round((target.workArea.height - height) / 2),
      width,
      height,
    }, target.workArea)
  }

  if (exact !== undefined) {
    return fitWindowToWorkArea({
      ...state.bounds,
      x: exact.workArea.x + state.bounds.x - state.displayWorkArea.x,
      y: exact.workArea.y + state.bounds.y - state.displayWorkArea.y,
    }, exact.workArea)
  }

  if (overlap !== undefined) return fitWindowToWorkArea(state.bounds, overlap.workArea)

  const width = Math.min(state.bounds.width, target.workArea.width)
  const height = Math.min(state.bounds.height, target.workArea.height)
  return fitWindowToWorkArea({
    x: target.workArea.x + Math.round((target.workArea.width - width) / 2),
    y: target.workArea.y + Math.round((target.workArea.height - height) / 2),
    width,
    height,
  }, target.workArea)
}

/** A best-effort desktop preference; malformed or unwritable state is ignored. */
export class WindowStateStore {
  private writes = Promise.resolve()

  constructor(private readonly path: string) {}

  async read(): Promise<StoredWindowState | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"))
      return isWindowState(value) ? value : undefined
    } catch {
      return undefined
    }
  }

  async remember(state: StoredWindowState): Promise<void> {
    if (!isWindowState(state)) return
    this.writes = this.writes.then(async () => {
      try {
        await writeFile(this.path, JSON.stringify(state), "utf8")
      } catch {
        // Window placement is a convenience. It must never make close or
        // startup fail when the profile directory is temporarily read-only.
      }
    })
    await this.writes
  }
}
