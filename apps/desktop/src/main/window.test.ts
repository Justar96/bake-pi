import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { frameBorderColor } from "./frame.ts"

describe("the main window's first paint", () => {
  test("subscribes before navigation can emit ready-to-show", () => {
    const source = readFileSync(new URL("./window.ts", import.meta.url), "utf8")
    const subscription = source.indexOf('window.once("ready-to-show"')
    const navigation = source.indexOf("await window.loadURL")

    expect(subscription).toBeGreaterThan(-1)
    expect(navigation).toBeGreaterThan(subscription)
  })

  test("keeps the native desktop frame subtly rounded", () => {
    const source = readFileSync(new URL("./window.ts", import.meta.url), "utf8")

    expect(source).toContain("roundedCorners: true")
  })

  test("paints the Windows frame edge in the chrome's tint, and keeps it there", () => {
    const source = readFileSync(new URL("./window.ts", import.meta.url), "utf8")

    expect(source).toContain("thickFrame: true")
    expect(source).toContain("accentColor: frameBorderColor(nativeTheme.shouldUseDarkColors)")
    expect(source).toContain('nativeTheme.on("updated"')
    expect(source).toContain("window.setAccentColor(frameBorderColor(nativeTheme.shouldUseDarkColors))")
    expect(source).not.toContain("accentColor: false")
  })

  test("the frame edge mirrors the border token from the renderer's dark and light themes", () => {
    const tokens = readFileSync(new URL("../renderer/theme/tokens.stylex.ts", import.meta.url), "utf8")
    const border = [...tokens.matchAll(/^  border: "(#[0-9a-f]{6})"/gm)].map((match) => match[1] ?? "")

    expect([frameBorderColor(true), frameBorderColor(false)]).toEqual(border.slice(0, 2))
  })

  test("restores and updates placement through Electron's DIP display geometry", () => {
    const source = readFileSync(new URL("./window.ts", import.meta.url), "utf8")

    expect(source).toContain("screen.getAllDisplays()")
    expect(source).toContain("screen.getDisplayMatching(window.getBounds())")
    expect(source).toContain('screen.on("display-metrics-changed"')
    expect(source).not.toContain("scaleFactor *")
    expect(source).not.toContain("/ scaleFactor")
  })

  test("lets Electron anchor the replacement title-bar menu to the live cursor", () => {
    const source = readFileSync(new URL("./window.ts", import.meta.url), "utf8")

    const handler = source.indexOf('window.on("system-context-menu"')
    const preventNative = source.indexOf("event.preventDefault()", handler)
    const popup = source.indexOf("menu.popup({ window })", handler)

    expect(handler).toBeGreaterThan(-1)
    expect(preventNative).toBeGreaterThan(handler)
    expect(popup).toBeGreaterThan(preventNative)
    expect(source).not.toContain("screen.screenToDipPoint")
  })
})
