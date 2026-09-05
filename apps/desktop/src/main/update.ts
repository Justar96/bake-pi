import { app, autoUpdater, dialog } from "electron"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"

/**
 * Updates, through Electron's own `autoUpdater` and nothing else.
 *
 * On Windows the package is a Squirrel installer (`forge.config.ts`), and
 * Squirrel is what `autoUpdater` speaks natively: it downloads the next
 * release's delta or full `.nupkg`, stages it beside the running version, and
 * `quitAndInstall` swaps the shortcut. The feed is `update.electronjs.org`,
 * a static redirector over GitHub Releases that needs no server of ours —
 * it reads the `RELEASES` file the publisher uploads and answers 204 when the
 * running version is current. That ties the feed to a public repository,
 * which this one is.
 *
 * Nothing here runs without Squirrel's `Update.exe` one directory above the
 * executable, which is where an installed copy has it. An unpackaged Electron
 * has none, and neither does the bare `out/` package directory, so both
 * would only log a failed check on every launch. It is also
 * Windows-only for now, because Windows is the platform with a maker.
 * macOS wants a signed `.zip` feed and Linux has no `autoUpdater` at all;
 * both are Milestone 5 work and both start from this file.
 *
 * The check is quiet. A failed check logs and is retried on the next interval
 * — a laptop that opened offline should not open with an error about it — and
 * only a downloaded update speaks, once, with a restart the person can decline.
 * Declining leaves it staged: Squirrel applies it on the next launch anyway.
 */

const REPOSITORY = "Justar96/bake-pi"
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

export const installUpdater = (): void => {
  if (!app.isPackaged || process.platform !== "win32") return
  if (!existsSync(join(dirname(process.execPath), "..", "Update.exe"))) return

  autoUpdater.setFeedURL({
    url: `https://update.electronjs.org/${REPOSITORY}/${process.platform}-${process.arch}/${app.getVersion()}`,
  })

  autoUpdater.on("error", (error) => {
    console.warn("[update] check failed", error.message)
  })

  autoUpdater.on("update-downloaded", (_event, _notes, version) => {
    void dialog.showMessageBox({
      type: "info",
      title: "Update ready",
      message: `Bake Pi ${version} has been downloaded.`,
      detail: "Restart to finish installing it. If you keep working, it is applied the next time Bake Pi starts.",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall()
    })
  })

  const check = (): void => {
    try {
      autoUpdater.checkForUpdates()
    } catch (error) {
      console.warn("[update] check could not start", error)
    }
  }
  check()
  const timer = setInterval(check, CHECK_INTERVAL_MS)
  // Unref'd so a pending check never holds the process open past quit.
  timer.unref()
}
