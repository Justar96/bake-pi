import { watch } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { appRoot, repoRoot } from "./shared.ts"

/**
 * The development loop: rebuild what changed, and show it without a restart.
 *
 * Two different things happen depending on what was edited, because Electron
 * can replace a renderer document at any time and cannot replace its own main
 * process at all. A renderer edit is rebuilt and the running app reloads itself
 * — `src/main/dev-reload.ts` is watching the bundle for exactly this. A main,
 * preload, or host edit means the process holding that code has to be replaced,
 * so the app is restarted here.
 *
 * The split is not a convenience. Restarting on every edit would discard the Pi
 * host and the conversation with it, which makes iterating on the interface a
 * matter of setting the state back up each time.
 */

type Target = "renderer" | "main" | "preload" | "agent-host"

const TARGETS: Target[] = ["renderer", "main", "preload", "agent-host"]

/**
 * Each rebuild is its own process, which is not the obvious choice and is not
 * an arbitrary one.
 *
 * Calling `buildRenderer()` a second time inside one process fails — measured,
 * on sources that had just built: the StyleX plugin carries state across builds
 * and the second pass rejects a media query it accepted moments earlier. A
 * fresh process cannot inherit that. The cost is one interpreter start against a
 * four-second StyleX compile, and in exchange a rebuild behaves exactly like the
 * cold build the gates run.
 */
const rebuild = async (target: Target): Promise<number> => {
  const started = Bun.nanoseconds()
  const child = Bun.spawn(["bun", "run", join(appRoot, `build/${target}.build.ts`)], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env },
  })
  if ((await child.exited) !== 0) throw new Error(`${target} build failed`)
  return Math.round((Bun.nanoseconds() - started) / 1e6)
}

/** A restart is only forced by the code that lives outside the renderer process. */
const RESTARTS_APP: Record<Target, boolean> = { renderer: false, main: true, preload: true, "agent-host": true }

/**
 * Which sources feed which bundle. The contract feeds all four, which is why it
 * is listed rather than inferred: a change to a shared schema that rebuilt only
 * the renderer would leave the host validating against the previous one, and
 * the mismatch would present as a runtime handshake failure rather than as a
 * stale build.
 */
const SOURCES: { dir: string; targets: Target[] }[] = [
  { dir: join(appRoot, "src/renderer"), targets: ["renderer"] },
  { dir: join(appRoot, "src/main"), targets: ["main"] },
  { dir: join(appRoot, "src/preload"), targets: ["preload"] },
  { dir: join(repoRoot, "packages/agent-host/src"), targets: ["agent-host"] },
  { dir: join(repoRoot, "packages/contract/src"), targets: ["renderer", "main", "preload", "agent-host"] },
]

/** Editors write swap files, lock files and backups into the tree being watched. */
const SOURCE_FILE = /\.(ts|tsx|css|html)$/

/** Every target must have a script to spawn, or its edits would silently do nothing. */
for (const target of TARGETS) {
  if (!(await Bun.file(join(appRoot, `build/${target}.build.ts`)).exists())) {
    throw new Error(`no build script for ${target}`)
  }
}

const electronBinary = async (): Promise<string> => {
  const dist = join(repoRoot, "node_modules/electron/dist")
  return join(dist, (await readFile(join(repoRoot, "node_modules/electron/path.txt"), "utf8")).trim())
}

export const watchBuild = async (): Promise<void> => {
  const binary = await electronBinary()

  let app: ReturnType<typeof Bun.spawn> | undefined
  let replacing = false

  const start = (): void => {
    app = Bun.spawn([binary, appRoot], { stdio: ["inherit", "inherit", "inherit"] })
    const child = app
    void child.exited.then(() => {
      // A window the user closed ends the session; one this script killed does
      // not. Without the distinction, every restart would also exit the watcher.
      if (replacing || child !== app) return
      console.log("[dev] the app exited")
      process.exit(0)
    })
  }

  const restart = async (): Promise<void> => {
    if (app === undefined) return start()
    replacing = true
    app.kill()
    await app.exited
    replacing = false
    start()
  }

  /*
   * Edits arrive in bursts — a formatter rewriting a file, a save touching an
   * import and its module — and a build started on the first of them would read
   * a half-written tree and then be immediately obsolete. Collect what changed,
   * settle, then build once.
   */
  const pending = new Set<Target>()
  let settling: ReturnType<typeof setTimeout> | undefined
  let building = false

  const flush = async (): Promise<void> => {
    if (building || pending.size === 0) return
    building = true
    const targets = [...pending]
    pending.clear()
    try {
      const times = await Promise.all(targets.map((target) => rebuild(target)))
      targets.forEach((target, index) => console.log(`[dev] rebuilt ${target} in ${String(times[index]!)} ms`))
      if (targets.some((target) => RESTARTS_APP[target])) {
        console.log("[dev] restarting the app — this build is not the renderer's")
        await restart()
      }
    } catch (error) {
      // A build that failed is a typo, not the end of the session. The child has
      // already printed the diagnostics that name the file and the line, so this
      // only says which bundle is now stale; the app goes on running the last
      // one that compiled.
      console.error(`[dev] ${error instanceof Error ? error.message : String(error)} — the app is still on the previous bundle`)
    } finally {
      building = false
      // Anything that arrived while this build ran is still owed a build.
      if (pending.size > 0) void flush()
    }
  }

  for (const { dir, targets } of SOURCES) {
    const watcher = watch(dir, { recursive: true }, (_event, file) => {
      if (file !== null && !SOURCE_FILE.test(file)) return
      for (const target of targets) pending.add(target)
      if (settling !== undefined) clearTimeout(settling)
      settling = setTimeout(() => void flush(), 120)
    })
    process.on("exit", () => watcher.close())
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      replacing = true
      app?.kill()
      process.exit(0)
    })
  }

  console.log(`[dev] watching ${String(SOURCES.length)} source roots — renderer edits reload, others restart`)
  start()
}
