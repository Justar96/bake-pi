import { watch } from "node:fs"
import type { BrowserWindow } from "electron"

/**
 * The channel between a rebuild and the window, which is the filesystem.
 *
 * A watch build has no way to reach a running Electron: it is a separate
 * process holding no IPC to the app, and the app registers no port for it. What
 * both of them can see is `dist/renderer`, so that is the signal — the build
 * writes the bundle, the main process notices the write and reloads the window
 * it already has a handle to.
 *
 * Reloading rather than restarting is the whole point. The renderer is a
 * projection of host state, so a reloaded document re-fences from a snapshot and
 * comes back to the same conversation; `did-finish-load` in the entry module
 * already hands the new document an event port, which is what makes a reload a
 * recovery rather than a dead window. Restarting Electron would instead discard
 * the Pi host, the window's position, and several seconds.
 *
 * Deliberately not `Bun.build`'s watch mode or a websocket: this is nine lines
 * of coupling that survive whether the app was started by `bun run dev` or by
 * hand.
 */
export const watchRendererBundle = (bundle: string, window: BrowserWindow): (() => void) => {
  if (process.env.NODE_ENV === "production") return () => undefined

  // Only the stamp, which `renderer.build.ts` writes after every other output
  // and after it has checked them. Watching the chunks instead would reload the
  // app partway through a build — and on Windows the reopened files then block
  // the writes the build has not made yet, so the build fails and the app is
  // left showing half of the previous one.
  let settling: ReturnType<typeof setTimeout> | undefined
  const watcher = watch(bundle, (_event, file) => {
    if (file !== "build-stamp") return
    // The stamp can still arrive as two events for one write.
    if (settling !== undefined) clearTimeout(settling)
    settling = setTimeout(() => {
      if (window.isDestroyed()) return
      console.log("[dev] renderer rebuilt — reloading")
      window.webContents.reload()
    }, 30)
  })
  // Nothing should be kept alive by a convenience.
  watcher.unref()

  return () => {
    if (settling !== undefined) clearTimeout(settling)
    watcher.close()
  }
}
