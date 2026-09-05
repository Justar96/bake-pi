/**
 * Renders the application icon from `assets/app-icon` into the files the
 * package and the development window consume: `apps/desktop/build/icon.ico`
 * for the Windows executable and installer, `apps/desktop/build/icon.png` for
 * everything that takes a bitmap. Both are committed, like `windows.manifest`,
 * so packaging needs no image step of its own; run this when the artwork
 * changes.
 *
 * The source is the 1024px master, `07-cube-connected-v1.png`. The resized
 * frames come from Electron's `nativeImage`, driven through
 * `app-icon.electron.cjs`, because that is the only resampler this repository
 * already depends on. The `.ico` is then assembled here: since Windows Vista an
 * icon directory may hold PNG-compressed frames directly, so the container is
 * a 6-byte header, one 16-byte entry per frame and the PNG bytes concatenated
 * — no BMP conversion, no palette, no mask.
 *
 * 256 is the largest frame an `.ico` may declare (its width and height bytes
 * wrap to 0 at that size), and 16 is what the Windows taskbar and Explorer's
 * small views draw. The sizes between are the ones Explorer and Squirrel's
 * shortcut code ask for; a size that is missing is scaled by Windows from the
 * nearest one, which is where a blurred taskbar icon comes from.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const source = join(root, "assets/app-icon/07-cube-connected-v1.png")
const outDir = join(root, "apps/desktop/build")
const electron = join(root, "node_modules/electron/dist", process.platform === "win32" ? "electron.exe" : "electron")

/** Largest first: Windows reads the directory in order and this is the customary layout. */
export const ICO_SIZES = [256, 128, 64, 48, 40, 32, 24, 20, 16] as const
/** The bitmap the development window and any non-Windows surface take. */
const PNG_SIZE = 512

const ICONDIR_BYTES = 6
const ICONDIRENTRY_BYTES = 16

/** Assembles a PNG-framed `.ico`. Every frame must be a square PNG of the size given. */
export const buildIco = (frames: { size: number; png: Uint8Array }[]): Buffer => {
  const header = Buffer.alloc(ICONDIR_BYTES)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(frames.length, 4)
  const entries: Buffer[] = []
  let offset = ICONDIR_BYTES + ICONDIRENTRY_BYTES * frames.length
  for (const { size, png } of frames) {
    const entry = Buffer.alloc(ICONDIRENTRY_BYTES)
    // Width and height are bytes; 256 is written as 0.
    entry.writeUInt8(size === 256 ? 0 : size, 0)
    entry.writeUInt8(size === 256 ? 0 : size, 1)
    entry.writeUInt8(0, 2) // colour palette: none
    entry.writeUInt8(0, 3) // reserved
    entry.writeUInt16LE(1, 4) // colour planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(png.byteLength, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += png.byteLength
  }
  return Buffer.concat([header, ...entries, ...frames.map(({ png }) => Buffer.from(png))])
}

if (import.meta.main) {
  const frameDir = mkdtempSync(join(tmpdir(), "bake-pi-icon-"))
  try {
    const sizes = [...new Set<number>([PNG_SIZE, ...ICO_SIZES])]
    const rendered = Bun.spawnSync([electron, join(import.meta.dir, "app-icon.electron.cjs"), source, frameDir, ...sizes.map(String)], {
      stdout: "inherit",
      stderr: "inherit",
      // Electron would otherwise inherit a renderer-hostile environment from
      // the dev shell; nothing here needs one either way.
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: "0" },
    })
    if (rendered.exitCode !== 0) throw new Error(`electron exited ${String(rendered.exitCode)} while rendering icon frames`)
    const frames = ICO_SIZES.map((size) => ({ size, png: new Uint8Array(readFileSync(join(frameDir, `${String(size)}.png`))) }))
    writeFileSync(join(outDir, "icon.ico"), buildIco(frames))
    writeFileSync(join(outDir, "icon.png"), readFileSync(join(frameDir, `${String(PNG_SIZE)}.png`)))
    console.log(`app-icon: wrote apps/desktop/build/icon.ico (${String(ICO_SIZES.length)} frames) and icon.png (${String(PNG_SIZE)}px) from ${source}`)
  } finally {
    rmSync(frameDir, { recursive: true, force: true })
  }
}
