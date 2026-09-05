import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { PiStore } from "./store.ts"
import { readNpmTarball } from "./tarball.ts"
import { fetchInstallPlan, fetchPackage, type PiInstallPlan, type PiPackage } from "./upstream.ts"

/**
 * Builds a managed Pi from what upstream published.
 *
 * The unusual decision here is that nothing is executed. npm would run the
 * `postinstall` of the three packages in Pi's closure that declare one, and
 * this does not: an update triggered from a settings panel would otherwise run
 * arbitrary downloaded code with the application's own privileges, on a machine
 * where the person clicking the button was asking for a newer agent and nothing
 * else. It is the same choice `npm ci --ignore-scripts` offers, made once and
 * not offered.
 *
 * That is safe for this closure rather than in general, and the reason is worth
 * writing down. `esbuild` installs a platform binary in its postinstall, and
 * upstream's lockfile already contains every `@esbuild/*` platform package, so
 * the script would find its binary already present and do nothing. `protobufjs`
 * and `@google/genai` generate optional type shims. Pi's own code paths that
 * Bake Pi drives — the agent, its tools, its sessions — do not reach any of
 * them. A future release that adds a package needing its script is a real
 * failure mode, and the answer to it is the bundled Pi, one button away.
 */

/** Enough parallelism to saturate a home connection; few enough to stay a good citizen. */
const CONCURRENCY = 8

export interface InstallProgress {
  readonly phase: "planning" | "downloading" | "activating"
  readonly completed: number
  readonly total: number
  /** The package just finished, when there is one. */
  readonly current: string | undefined
}

export interface InstallOptions {
  readonly onProgress?: (progress: InstallProgress) => void
  readonly signal?: AbortSignal
}

const stopped = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) throw new Error("the install was cancelled")
}

/**
 * Unpacks one package into its lockfile-appointed directory.
 *
 * Directories are created per file rather than up front. The alternative is
 * collecting the distinct parents first, which costs a pass and a set to save
 * `mkdir` calls that are already no-ops after the first one.
 */
const unpack = (destination: string, tarball: Uint8Array): void => {
  mkdirSync(destination, { recursive: true })
  for (const entry of readNpmTarball(tarball)) {
    const target = join(destination, entry.path)
    mkdirSync(dirname(target), { recursive: true })
    // Mode is narrowed to the executable bit, which is the only part of a
    // tarball's permissions this application has any business reproducing.
    writeFileSync(target, entry.contents, { mode: (entry.mode & 0o111) === 0 ? 0o644 : 0o755 })
  }
}

/**
 * Runs a fixed number of workers over the plan.
 *
 * A shared cursor rather than chunking the list, because package sizes vary by
 * three orders of magnitude: eight equal slices would spend their last minute
 * with seven workers idle behind whichever one drew Pi itself.
 */
const downloadAll = async (
  packages: readonly PiPackage[],
  root: string,
  options: InstallOptions,
): Promise<void> => {
  let next = 0
  let completed = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      const entry = packages[index]
      if (entry === undefined) return
      stopped(options.signal)
      try {
        unpack(join(root, entry.path), await fetchPackage(entry))
      } catch (error) {
        /*
          An optional package is optional because npm recorded that this tree
          works without it — they are the other platforms' native binaries, and
          the one for this platform is not optional. Failing the whole install
          over a dependency the lockfile itself marks as skippable would make
          updates fail for reasons that do not matter.
        */
        if (!entry.optional) throw error
      }
      completed += 1
      options.onProgress?.({ phase: "downloading", completed, total: packages.length, current: entry.name })
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, packages.length) }, worker))
}

export interface InstallResult {
  readonly version: string
  readonly packages: number
}

/**
 * Installs one upstream Pi version and points the store at it.
 *
 * The store is swept first. A previous run that was killed mid-download leaves
 * a staging directory of some hundreds of megabytes, and the moment someone
 * asks for an install is exactly the moment to reclaim it — before, not after,
 * this run needs the space.
 */
export const installPi = async (
  store: PiStore,
  version: string,
  options: InstallOptions = {},
): Promise<InstallResult> => {
  options.onProgress?.({ phase: "planning", completed: 0, total: 0, current: undefined })
  store.sweep()

  const plan: PiInstallPlan = await fetchInstallPlan(version)
  stopped(options.signal)

  mkdirSync(store.stagingDir, { recursive: true })
  const staged = mkdtempSync(join(store.stagingDir, `${version}-`))
  try {
    await downloadAll(plan.packages, staged, options)
    stopped(options.signal)
    options.onProgress?.({ phase: "activating", completed: plan.packages.length, total: plan.packages.length, current: undefined })
    store.commit(staged, version, plan.packages.length)
    store.activate(version)
  } catch (error) {
    rmSync(staged, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    throw error
  }
  return { version, packages: plan.packages.length }
}
