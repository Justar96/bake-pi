/**
 * Holds the native window frame to the renderer's border hairline, on every
 * display. Windows only.
 *
 * Every other check in this repository stops at the renderer's edge: DOM
 * assertions and DevTools screenshots both end where the web contents end.
 * The line Windows draws around a hidden-title-bar window lives outside that,
 * on the frame DWM owns, so a grey seam down both sides of the app passed
 * `bun run journey` for as long as it existed. This is the check that could
 * have seen it: it launches the real application, brings the window to the
 * front, photographs the desktop, and reads the pixels.
 *
 * It does so once per display, because the second defect this check exists
 * for only appears on a display whose scale differs from the primary's. Under
 * per-monitor DPI awareness v1 — Electron's default — Windows sizes the frame
 * at the primary display's DPI while Chromium insets the client area by the
 * current display's, and the difference shows as a band of frame colour inside
 * the hairline on the left, right and bottom. `build/windows.manifest` opts the
 * executable into v2; this is what proves the manifest reached the binary that
 * actually ran.
 *
 * Per display it asserts: the window is per-monitor v2; the visible frame is
 * the same width on the left, right and bottom, and no wider than the hairline
 * that display's scale rounds to; the top has none, because Chromium extends
 * the client area to the top edge and DWM paints the line over it; every
 * visible frame pixel is `frameBorderColor` for the desktop's appearance and
 * the pixel just inside is not, so the line is a hairline rather than a band;
 * and the four extreme corners are not the border colour, which is what a
 * rounded corner looks like from outside. It runs windowed — Windows squares
 * the corners of a maximized window by design.
 *
 * On demand, not in `verify`: it needs a real desktop session with the window
 * unobscured, which a CI runner does not have.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { frameBorderColor } from "../apps/desktop/src/main/frame.ts"
import type { StoredWindowState } from "../apps/desktop/src/main/window-state.ts"
import { DEFAULT_WINDOW_SIZE } from "../apps/desktop/src/main/window-state.ts"

const root = join(import.meta.dir, "..")
const electronBinary = join(root, "node_modules/electron/dist/electron.exe")
const TIMEOUT_MS = 60_000

if (process.platform !== "win32") {
  console.log("frame: the DWM border only exists on Windows; nothing to check here")
  process.exit(0)
}

type Side = "top" | "bottom" | "left" | "right"
const SIDES: readonly Side[] = ["top", "bottom", "left", "right"]

interface Display {
  id: number
  primary: boolean
  workArea: { x: number; y: number; width: number; height: number }
  scaleFactor: number
}

interface Sample {
  foreground: boolean
  perMonitorV2: boolean
  dpi: number
  frame: { x: number; y: number; width: number; height: number }
  thickness: Record<Side, number>
  pixels: Record<Side, string[]>
  corner: Record<"topLeft" | "topRight" | "bottomLeft" | "bottomRight", string>
}

/** Electron reads the same registry value for `nativeTheme.shouldUseDarkColors`. */
const desktopIsDark = (): boolean => {
  const query = Bun.spawnSync(["reg", "query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize", "/v", "AppsUseLightTheme"])
  const match = /AppsUseLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(query.stdout.toString())
  return match === null ? true : Number.parseInt(match[1]!, 16) === 0
}

/** Screen capture rounds through colour management; a channel may land one off. */
const near = (actual: string, expected: string, tolerance = 2): boolean => {
  const channels = (hex: string): number[] => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
  const a = channels(actual)
  const b = channels(expected)
  return a.every((value, i) => Math.abs(value - b[i]!) <= tolerance)
}

const listDisplays = async (): Promise<Display[]> => {
  const probe = Bun.spawn([electronBinary, join(root, "scripts/fixtures/display-probe")], { stdout: "pipe", stderr: "ignore" })
  const output = await new Response(probe.stdout).text()
  await probe.exited
  const line = output.split(/\r?\n/).find((candidate) => candidate.startsWith("["))
  if (line === undefined) throw new Error(`the display probe printed no display list\n${output}`)
  return JSON.parse(line) as Display[]
}

/** The saved state that makes `window.ts` open the window on this display. */
const placementOn = (display: Display): StoredWindowState => {
  const width = Math.min(DEFAULT_WINDOW_SIZE.width, display.workArea.width)
  const height = Math.min(DEFAULT_WINDOW_SIZE.height, display.workArea.height)
  return {
    version: 1,
    bounds: {
      x: display.workArea.x + Math.round((display.workArea.width - width) / 2),
      y: display.workArea.y + Math.round((display.workArea.height - height) / 2),
      width,
      height,
    },
    displayId: display.id,
    displayWorkArea: display.workArea,
    maximized: false,
  }
}

const sampleOn = async (display: Display): Promise<Sample> => {
  const profile = mkdtempSync(join(tmpdir(), "bakepi-frame-"))
  writeFileSync(join(profile, "window-state.json"), JSON.stringify(placementOn(display)), "utf8")
  const child = Bun.spawn(
    [electronBinary, "--remote-debugging-port=0", `--user-data-dir=${profile}`, join(root, "apps/desktop")],
    { env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" }, stdout: "ignore", stderr: "pipe" },
  )
  try {
    // The window is shown on `ready-to-show`, and the first paint follows it.
    // Waiting for the page to answer over the debugging endpoint is the one
    // signal that the frame on screen has content behind it.
    const deadline = Date.now() + TIMEOUT_MS
    let stderr = ""
    const reader = (child.stderr as ReadableStream<Uint8Array>).getReader()
    let port: number | undefined
    while (port === undefined && Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      stderr += new TextDecoder().decode(value)
      const found = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr)
      if (found) port = Number(found[1])
    }
    if (port === undefined) throw new Error(`Electron never announced a debugging endpoint\n${stderr}`)
    let painted = false
    while (!painted && Date.now() < deadline) {
      try {
        const targets = (await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json()) as { url: string; title: string }[]
        painted = targets.some((target) => target.url.startsWith("bakepi://") && target.title.length > 0)
      } catch {
        // Not listening yet.
      }
      if (!painted) await Bun.sleep(200)
    }
    if (!painted) throw new Error("the renderer never loaded")
    await Bun.sleep(1_000)

    const probe = Bun.spawnSync(["pwsh", "-NoProfile", "-File", join(import.meta.dir, "frame.ps1"), String(child.pid)])
    if (probe.exitCode !== 0) throw new Error(`frame.ps1 failed\n${probe.stderr.toString()}`)
    return JSON.parse(probe.stdout.toString()) as Sample
  } finally {
    child.kill()
    await child.exited
    rmSync(profile, { recursive: true, force: true })
  }
}

const judge = (display: Display, sample: Sample, expected: string): string[] => {
  const failures: string[] = []
  const at = (message: string): void => {
    failures.push(`${message} (display ${String(display.id)} at ${String(display.scaleFactor * 100)}%)`)
  }
  // Windows draws the one-DIP border at the display's scale and rounds up:
  // 1 px at 100%, 2 px at 150%. Anything wider is frame showing through.
  const hairline = Math.ceil(display.scaleFactor)
  const { thickness } = sample

  if (!sample.foreground) at("the window could not be brought to the foreground, so the capture may show something else")
  if (!sample.perMonitorV2) at("the window is not per-monitor DPI aware v2: build/windows.manifest has not been stamped into electron.exe — run `bun install`")
  if (thickness.top !== 0) at(`the client area stops ${String(thickness.top)} px short of the top edge`)
  for (const side of ["left", "right", "bottom"] as const) {
    if (thickness[side] > hairline) at(`the ${side} edge shows ${String(thickness[side])} px of frame; the hairline at this scale is ${String(hairline)} px`)
    if (thickness[side] < 1) at(`the ${side} edge has no frame at all`)
  }
  if (new Set([thickness.left, thickness.right, thickness.bottom]).size !== 1) {
    at(`the frame is ${String(thickness.left)} px left, ${String(thickness.right)} px right and ${String(thickness.bottom)} px bottom; it should be one width`)
  }
  for (const side of SIDES) {
    // The top's line is painted over the client area, so it is `hairline` deep
    // there too; elsewhere it is exactly as deep as the frame Windows shows.
    const depth = side === "top" ? hairline : Math.max(1, thickness[side])
    const run = sample.pixels[side]
    for (let i = 0; i < depth; i += 1) {
      if (!near(run[i]!, expected)) at(`the ${side} edge is ${run[i]!} at ${String(i)} px in, not ${expected}`)
    }
    if (near(run[depth]!, expected)) at(`the ${side} edge is more than ${String(depth)} px of border colour`)
  }
  for (const [corner, colour] of Object.entries(sample.corner)) {
    if (near(colour, expected)) at(`the ${corner} corner is square: its outermost pixel is the border colour`)
  }
  return failures
}

const expected = frameBorderColor(desktopIsDark())
const displays = await listDisplays()
console.log(`frame: ${String(displays.length)} display(s); expecting ${expected}`)

const failures: string[] = []
for (const display of displays) {
  const sample = await sampleOn(display)
  const scale = `${String(display.scaleFactor * 100)}%`
  const awareness = sample.perMonitorV2 ? "per-monitor v2" : "per-monitor v1"
  console.log(`  display ${String(display.id)}${display.primary ? " (primary)" : ""} at ${scale}: ${String(sample.frame.width)}x${String(sample.frame.height)} at ${String(sample.frame.x)},${String(sample.frame.y)}; ${String(sample.dpi)} dpi; ${awareness}`)
  for (const side of SIDES) {
    console.log(`    ${side.padEnd(6)} frame ${String(sample.thickness[side])} px  ${sample.pixels[side].slice(0, 4).join(" ")}`)
  }
  console.log(`    corners ${Object.values(sample.corner).join(" ")}`)
  failures.push(...judge(display, sample, expected))
}

if (failures.length > 0) {
  console.error(`\nframe: ${String(failures.length)} finding(s)`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log("frame: the DWM edge is the theme hairline on all four sides of every display and the corners are rounded")
