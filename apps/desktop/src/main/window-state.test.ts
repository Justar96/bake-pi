import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  WindowStateStore,
  fitWindowToWorkArea,
  resolveWindowPlacement,
  type StoredWindowState,
  type WindowDisplay,
} from "./window-state.ts"

const primary: WindowDisplay = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
const secondary: WindowDisplay = { id: 2, workArea: { x: -1280, y: 120, width: 1280, height: 720 } }
const temporary: string[] = []

const state = (overrides: Partial<StoredWindowState> = {}): StoredWindowState => ({
  version: 1,
  bounds: { x: -1200, y: 160, width: 1000, height: 650 },
  displayId: secondary.id,
  displayWorkArea: secondary.workArea,
  maximized: false,
  ...overrides,
})

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe("multi-display window placement", () => {
  test("centres a first launch in the primary display's DIP work area", () => {
    expect(resolveWindowPlacement(undefined, [primary, secondary], primary)).toEqual({
      x: 320,
      y: 90,
      width: 1280,
      height: 860,
      minWidth: 720,
      minHeight: 600,
    })
  })

  test("keeps a window's display-relative position after monitors are rearranged", () => {
    const moved = { ...secondary, workArea: { ...secondary.workArea, x: 1920, y: 0 } }

    expect(resolveWindowPlacement(state(), [primary, moved], primary)).toEqual({
      x: 2000,
      y: 40,
      width: 1000,
      height: 650,
      minWidth: 720,
      minHeight: 600,
    })
  })

  test("preserves a visible negative-coordinate placement when display ids change", () => {
    const replacement = { ...secondary, id: 20 }

    expect(resolveWindowPlacement(state(), [primary, replacement], primary).x).toBe(-1200)
  })

  test("centres an off-screen window on primary when its display is gone", () => {
    const missing = state({ bounds: { x: -2000, y: 100, width: 1000, height: 650 } })

    expect(resolveWindowPlacement(missing, [primary], primary)).toEqual({
      x: 460,
      y: 195,
      width: 1000,
      height: 650,
      minWidth: 720,
      minHeight: 600,
    })
  })

  test("fits both bounds and minimum size on a high-scale display with little DIP space", () => {
    const compact = { x: 100, y: 50, width: 640, height: 480 }

    expect(fitWindowToWorkArea({ x: 0, y: 0, width: 1280, height: 860 }, compact)).toEqual({
      ...compact,
      minWidth: 640,
      minHeight: 480,
    })
  })

  test("refits saved DIP bounds when increased scaling shrinks the same display's work area", () => {
    const highScale = { ...secondary, workArea: { x: -800, y: 0, width: 800, height: 450 } }

    expect(resolveWindowPlacement(state(), [primary, highScale], primary)).toEqual({
      x: -800,
      y: 0,
      width: 800,
      height: 450,
      minWidth: 720,
      minHeight: 450,
    })
  })
})

describe("window state preference", () => {
  test("round-trips validated DIP bounds and display metadata", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bakepi-window-state-"))
    temporary.push(directory)
    const store = new WindowStateStore(join(directory, "window-state.json"))

    await store.remember(state({ maximized: true }))

    expect(await store.read()).toEqual(state({ maximized: true }))
  })

  test("ignores missing, malformed and physically impossible state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bakepi-window-state-"))
    temporary.push(directory)
    const path = join(directory, "window-state.json")
    const store = new WindowStateStore(path)
    expect(await store.read()).toBeUndefined()

    writeFileSync(path, "not json", "utf8")
    expect(await store.read()).toBeUndefined()

    writeFileSync(path, JSON.stringify(state({ bounds: { x: 0, y: 0, width: 0, height: 600 } })), "utf8")
    expect(await store.read()).toBeUndefined()
  })
})
