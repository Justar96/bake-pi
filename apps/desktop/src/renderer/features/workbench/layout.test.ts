import { describe, expect, test } from "bun:test"
import {
  BREAKPOINT_ACTIVITY,
  BREAKPOINT_FILES,
  MIN_CONVERSATION,
  RAIL_ACTIVITY,
  RAIL_FILES,
  fitColumns,
  fitRail,
  preferredRailWidths,
  railsInGrid,
} from "./layout.ts"

describe("which rails occupy the grid", () => {
  test("both sit in the grid above 1200", () => {
    expect(railsInGrid(1201)).toEqual({ files: true, activity: true })
  })

  test("activity folds at 1200, files stay until 960", () => {
    expect(railsInGrid(1200)).toEqual({ files: true, activity: false })
    expect(railsInGrid(961)).toEqual({ files: true, activity: false })
  })

  test("both are off-canvas below the files breakpoint", () => {
    expect(railsInGrid(BREAKPOINT_FILES)).toEqual({ files: false, activity: false })
    expect(railsInGrid(720)).toEqual({ files: false, activity: false })
  })
})

describe("fitting rails to a window", () => {
  test("a wide window keeps the asked widths", () => {
    expect(fitColumns(248, 280, 1440)).toEqual({
      files: 248,
      activity: 280,
      filesInGrid: true,
      activityInGrid: true,
    })
  })

  test("a window just above 1200 shrinks the rails so 480px of conversation survives", () => {
    const fit = fitColumns(RAIL_FILES.max, RAIL_ACTIVITY.max, 1201)
    expect(fit.filesInGrid).toBe(true)
    expect(fit.activityInGrid).toBe(true)
    expect(fit.files + fit.activity + MIN_CONVERSATION).toBeLessThanOrEqual(1201)
    expect(fit.files).toBeGreaterThanOrEqual(RAIL_FILES.min)
    expect(fit.activity).toBeGreaterThanOrEqual(RAIL_ACTIVITY.min)
  })

  test("below 1200 the activity rail is not in the budget, so files can use the room", () => {
    const fit = fitColumns(RAIL_FILES.max, RAIL_ACTIVITY.max, 1000)
    expect(fit.filesInGrid).toBe(true)
    expect(fit.activityInGrid).toBe(false)
    expect(fit.files).toBe(RAIL_FILES.max)
    expect(fit.files + MIN_CONVERSATION).toBeLessThanOrEqual(1000)
  })

  test("below 960 neither rail is in the budget", () => {
    const fit = fitColumns(RAIL_FILES.max, RAIL_ACTIVITY.max, 800)
    expect(fit.filesInGrid).toBe(false)
    expect(fit.activityInGrid).toBe(false)
  })

  test("asked widths outside the rail's own limits are clamped first", () => {
    expect(fitColumns(80, 900, 1600)).toMatchObject({ files: RAIL_FILES.min, activity: RAIL_ACTIVITY.max })
  })

  test("dragging one rail yields before the conversation floor, and ignores an overlayed neighbour", () => {
    // 1000px: activity is off-canvas, so a 280px activity preference must not
    // cap the files rail at 1000 - 280 - 480 = 240.
    expect(fitRail(420, RAIL_FILES, 0, 1000)).toBe(420)
    expect(fitRail(420, RAIL_FILES, 280, 1201)).toBeLessThanOrEqual(1201 - 280 - MIN_CONVERSATION)
  })
})

describe("fluid rail defaults", () => {
  const base = { files: 248, activity: 280 }

  test("preserve the authored scale at 1440px", () => {
    expect(preferredRailWidths(1440, base)).toEqual(base)
  })

  test("grow on a wide window without consuming the manual resize range", () => {
    expect(preferredRailWidths(1920, base)).toEqual({ files: 320, activity: 360 })
    expect(preferredRailWidths(2560, base)).toEqual({ files: 320, activity: 360 })
  })

  test("stay readable near the docking breakpoints and remain on the four-pixel grid", () => {
    const widths = preferredRailWidths(BREAKPOINT_ACTIVITY, base)
    expect(widths).toEqual({ files: 232, activity: 264 })
    expect(widths.files % 4).toBe(0)
    expect(widths.activity % 4).toBe(0)
  })
})

test("interactive tab-strip controls opt out of the window drag region", async () => {
  const strip = await Bun.file(new URL("./TabStrip.tsx", import.meta.url)).text()
  for (const name of ["tab:", "newTab:", "controls:", "controlIcon:", "filesToggle:"]) {
    const block = new RegExp(`${name.replace(":", ":")}[\\s\\S]*?WebkitAppRegion: "no-drag"`).exec(strip)
    expect(block, `${name} sets no-drag`).not.toBeNull()
  }
  expect(strip).toContain("styles.dragFill")
  expect(strip).toContain('WebkitAppRegion: "drag"')
})

test("empty screens keep a title-bar-sized drag region", async () => {
  const app = await Bun.file(new URL("../../App.tsx", import.meta.url)).text()
  expect(app).toContain("windowDrag")
  expect(app).toContain("onWorkbench ? null")
  expect(app).toContain(`@media (max-width: ${String(BREAKPOINT_FILES)}px)`)
})

test("the breakpoints match the media queries the grid is written with", async () => {
  const workbench = await Bun.file(new URL("./Workbench.tsx", import.meta.url)).text()
  const strip = await Bun.file(new URL("./TabStrip.tsx", import.meta.url)).text()
  expect(workbench).toContain(`@media (max-width: ${String(BREAKPOINT_ACTIVITY)}px)`)
  expect(workbench).toContain(`@media (max-width: ${String(BREAKPOINT_FILES)}px)`)
  expect(strip).toContain(`@media (max-width: ${String(BREAKPOINT_ACTIVITY)}px)`)
  expect(strip).toContain(`@media (max-width: ${String(BREAKPOINT_FILES)}px)`)
})

test("the right track stays activity-only while utility surfaces are modal", async () => {
  const workbench = await Bun.file(new URL("./Workbench.tsx", import.meta.url)).text()
  const settings = await Bun.file(new URL("./SettingsRail.tsx", import.meta.url)).text()
  const sessions = await Bun.file(new URL("./SessionsRail.tsx", import.meta.url)).text()

  expect(workbench).toContain("fitColumns(filesWant, activityWant, innerWidth)")
  expect(workbench).toContain("<ProjectedActivity projection={projection}")
  expect(workbench).toContain("<SettingsModal")
  expect(workbench).toContain("<SessionsModal")
  expect(workbench).not.toContain("utilityRail")
  expect(settings).toContain('<Modal id="settings-modal"')
  expect(settings).toContain("wide contained")
  expect(sessions).toContain('<Modal id="sessions-modal"')
})

test("resizable and modal surfaces own the grids that reflow inside them", async () => {
  const workbench = await Bun.file(new URL("./Workbench.tsx", import.meta.url)).text()
  const settings = await Bun.file(new URL("./SettingsRail.tsx", import.meta.url)).text()
  const sessions = await Bun.file(new URL("./SessionsRail.tsx", import.meta.url)).text()

  expect(workbench).toContain('containerType: "inline-size"')
  // The activity rail has no grid to reflow: spend is a headline and a
  // wrapping line of pairs, which reads the same at every rail width.
  expect(settings).toContain('containerType: "inline-size"')
  expect(settings).toContain("@container (min-width: 360px)")
  expect(sessions).toContain('containerType: "inline-size"')
  expect(sessions).toContain("@container (min-width: 400px)")
})
