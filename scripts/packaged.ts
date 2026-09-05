/**
 * Proves the packaged application, not the development one.
 *
 * `bun run smoke` launches the stock Electron against `dist/`, which is the
 * right instrument for the code and the wrong one for the package: it cannot
 * see a fuse that was never flipped, an asar Pi is missing from, or an icon
 * that was never stamped. This runs after `bun run package` against
 * `apps/desktop/out/<name>-<platform>-<arch>` and checks the three things only
 * a package can get wrong.
 *
 * 1. **The fuse wire is what `forge.config.ts` declares.** Read back from the
 *    executable with `@electron/fuses`, compared entry by entry to the same
 *    object the config hands the plugin, so the two cannot drift.
 * 2. **It starts.** The same `BAKE_PI_SMOKE_OUT` protocol the development
 *    smoke uses: the app boots, reaches the Pi handshake, probes the renderer
 *    and shuts itself down, then writes a report. Here that also proves the
 *    staged `node_modules` resolve from inside the asar.
 * 3. **Nothing else is running under the same identity.** The app is
 *    single-instance, keyed on its user-data directory, so a development copy
 *    left open would make the package quit silently with code 0 and look like
 *    a broken build. A throwaway `--user-data-dir` keeps the two apart.
 *
 * The package is copied out of the repository before any of that, and the copy
 * is what runs. Node resolves a bare specifier by walking up from the importing
 * file, so a package sitting in `apps/desktop/out` reaches this repository's
 * own hoisted `node_modules` a few directories above it. Every dependency the
 * production stage forgets is therefore satisfied here and nowhere else: 0.1.0-beta.1
 * and .2 both passed this check on two machines and died at
 * `ERR_MODULE_NOT_FOUND` on the first one that had no such directory above the
 * install. Running from a temporary directory gives the walk nothing to find,
 * which is the only way this check can speak for an installed copy.
 *
 * On Linux the check passes `--no-sandbox`: the SUID `chrome_sandbox` helper
 * is configured by the deb and rpm on install and is not usable from a bare
 * `out/` directory, and unprivileged user namespaces are off on Ubuntu 24.04
 * runners. That is a property of where the binary sits, not of the build, and
 * the renderer sandbox is asserted by `bun run smoke` on every platform.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, parse as parsePath } from "node:path"
import { FuseV1Options, getCurrentFuseWire } from "@electron/fuses"
// Not re-exported from the package root, although the wire is typed in terms of it.
import { FuseState } from "@electron/fuses/dist/constants"
import { FUSES } from "../apps/desktop/forge.config.ts"

const root = join(import.meta.dir, "..")
const desktop = JSON.parse(readFileSync(join(root, "apps/desktop/package.json"), "utf8")) as { productName: string }
const platform = process.platform
const arch = process.arch
const packageDir = join(root, "apps/desktop/out", `${desktop.productName}-${platform}-${arch}`)

const executableIn = (directory: string): string => platform === "win32"
  ? join(directory, "bake-pi.exe")
  : platform === "darwin"
    ? join(directory, `${desktop.productName}.app/Contents/MacOS/bake-pi`)
    : join(directory, "bake-pi")

const fail = (message: string): never => {
  console.error(`packaged: ${message}`)
  process.exit(1)
}

if (!existsSync(executableIn(packageDir))) {
  fail(`no package at ${executableIn(packageDir)}; run \`bun run package\` first`)
}

/** Every directory from `from` up to the volume root, nearest first. */
const ancestors = function* (from: string): Generator<string> {
  const volume = parsePath(from).root
  let current = from
  while (true) {
    yield current
    if (current === volume) return
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

const scratch = mkdtempSync(join(tmpdir(), "bake-pi-packaged-"))
try {
  // Worth nothing if this directory has a `node_modules` above it either.
  // Better to say so than to pass for the same wrong reason twice.
  for (const directory of ancestors(scratch)) {
    if (existsSync(join(directory, "node_modules"))) {
      fail(`${directory} contains a node_modules, so a package under ${scratch} could still resolve a dependency the stage forgot`)
    }
  }

  const isolated = join(scratch, "package")
  const copyStarted = Bun.nanoseconds()
  cpSync(packageDir, isolated, { recursive: true })
  console.log(`packaged: copied out of the repository in ${String(Math.round((Bun.nanoseconds() - copyStarted) / 1e6))} ms`)
  const executable = executableIn(isolated)

  // 1. Fuses.
  const wire = await getCurrentFuseWire(executable)
  const fuseNames = Object.entries(FuseV1Options).filter(([, value]) => typeof value === "number") as [string, FuseV1Options][]
  const declared = FUSES as Partial<Record<FuseV1Options, boolean>>
  const mismatched: string[] = []
  let compared = 0
  for (const [name, option] of fuseNames) {
    const expected = declared[option]
    if (expected === undefined) continue
    compared += 1
    const actual = wire[option]
    const want = expected ? FuseState.ENABLE : FuseState.DISABLE
    if (actual !== want) mismatched.push(`${name}: expected ${expected ? "enabled" : "disabled"}, binary says ${actual === undefined ? "absent" : String.fromCharCode(actual)}`)
  }
  if (mismatched.length > 0) fail(`fuse wire differs from forge.config.ts\n  ${mismatched.join("\n  ")}`)
  console.log(`packaged: ${String(compared)} fuses match forge.config.ts`)

  // 2. Startup, under 3. its own identity.
  const reportPath = join(scratch, "smoke.json")
  const args = [`--user-data-dir=${join(scratch, "user-data")}`, ...(platform === "linux" ? ["--no-sandbox"] : [])]
  const started = Bun.nanoseconds()
  const run = Bun.spawnSync([executable, ...args], {
    env: { ...process.env, BAKE_PI_SMOKE_OUT: reportPath },
    stdout: "inherit",
    stderr: "inherit",
    // Well past the development smoke's budget; a package that has not written
    // its report by then has hung rather than started slowly.
    timeout: 120_000,
  })
  const ms = Math.round((Bun.nanoseconds() - started) / 1e6)
  if (!existsSync(reportPath)) fail(`no smoke report after ${String(ms)} ms (exit ${String(run.exitCode)}); the package did not reach its startup probe`)
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as { ok: boolean; error?: string; piVersion?: string; electron?: string; shutdown?: { acknowledged: boolean } }
  if (!report.ok) fail(`the package started and failed: ${report.error ?? "no error recorded"}`)
  if (report.shutdown?.acknowledged !== true) fail("the package started but its agent host did not acknowledge shutdown")
  console.log(`packaged: ${executable}`)
  console.log(`packaged: started, reached Pi ${report.piVersion ?? "?"} on Electron ${report.electron ?? "?"}, and shut down in ${String(ms)} ms`)
} finally {
  await discard(scratch)
}

/**
 * Removes the copy, and never fails the check for failing to.
 *
 * Windows releases the handles on a just-exited process's image lazily, so the
 * first `rm` of a 400 MB tree the app was running out of can arrive at `EBUSY`
 * — it did, on CI, for a package that had already started and shut down
 * cleanly. The directory is under the system temp directory and the operating
 * system will collect it; reporting the package broken because its scratch
 * copy outlived it by a second would be a worse answer than saying nothing.
 */
async function discard(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 10; ++attempt) {
    try {
      rmSync(directory, { recursive: true, force: true })
      return
    } catch {
      await Bun.sleep(200)
    }
  }
  console.warn(`packaged: left ${directory} behind; the operating system collects it`)
}
