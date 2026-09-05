/**
 * Stamps `apps/desktop/build/windows.manifest` into the development
 * electron.exe. Windows only; a no-op everywhere else and when already stamped.
 *
 * Electron's own manifest declares per-monitor DPI awareness v1, and under v1
 * Windows keeps the window frame at the primary monitor's DPI while Chromium
 * insets the client area by the current monitor's. The packaged executable gets
 * the corrected manifest from `forge.config.ts`; without this step the binary
 * `bun run dev`, `bun run smoke` and `bun run frame` launch would still be the
 * stock one, and a frame defect would be invisible in development and present
 * in the package, or the reverse. `bun install` runs this as `postinstall`, so
 * the two binaries agree.
 *
 * The manifest is a resource, so this is a resource edit rather than a byte
 * patch: the same `resedit` the packager uses, replacing RT_MANIFEST and
 * rewriting the resource section. The Authenticode signature on the stock
 * binary does not survive that, which is also true of the packaged binary
 * before it is signed, and Windows does not require one to run.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { NtExecutable, NtExecutableResource } from "resedit"

const root = join(import.meta.dir, "..")
const manifestPath = join(root, "apps/desktop/build/windows.manifest")
const electronPath = join(root, "node_modules/electron/dist/electron.exe")

/** RT_MANIFEST. Numeric resource types are not named by the library. */
const RT_MANIFEST = 24

export const stampManifest = (exePath: string, manifest: Buffer): "stamped" | "unchanged" => {
  const exe = NtExecutable.from(readFileSync(exePath))
  const resources = NtExecutableResource.from(exe)
  const entries = resources.entries.filter((entry) => entry.type === RT_MANIFEST)
  if (entries.length !== 1) throw new Error(`${exePath} carries ${String(entries.length)} manifests; expected exactly one`)
  const entry = entries[0]!
  if (Buffer.from(entry.bin).equals(manifest)) return "unchanged"
  entry.bin = new Uint8Array(manifest).buffer
  resources.outputResource(exe)
  writeFileSync(exePath, Buffer.from(exe.generate()))
  return "stamped"
}

if (import.meta.main) {
  if (process.platform !== "win32") {
    console.log("manifest: Windows resources only exist on Windows; nothing to stamp here")
    process.exit(0)
  }
  const outcome = stampManifest(electronPath, readFileSync(manifestPath))
  console.log(`manifest: node_modules/electron/dist/electron.exe ${outcome === "stamped" ? "now carries" : "already carries"} build/windows.manifest`)
}
