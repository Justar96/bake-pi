import { execFile } from "node:child_process"

/**
 * Tool subprocesses outlive the host, and the order they are killed in decides
 * whether that matters.
 *
 * A Bash or PowerShell command Pi spawned is not the host's problem to the OS —
 * on Windows especially, where nothing reaps a tree for you. Without this, the
 * interface would show "disconnected" while an orphaned command kept mutating
 * the workspace and its result never reached the session file.
 *
 * ## What was measured, because the guess was wrong in both directions
 *
 * `scripts/orphans.ts` runs the real topology — Electron main, a real
 * `utilityProcess`, a tool subprocess, and a process that tool itself started —
 * and kills it four ways. On Windows 11:
 *
 * | How the host dies | host | the tool | what the tool started |
 * | --- | --- | --- | --- |
 * | `child.kill()` alone | dies | dies | **survives** |
 * | `child.kill()` then `terminateTree` | dies | dies | **survives** |
 * | `terminateTree` then `child.kill()` | dies | dies | dies |
 * | main hard-killed from outside | dies | dies | dies |
 *
 * Two things in that table were the opposite of what this file used to claim.
 *
 * **The hard kill of main is not the leaky case.** It used to say so. Measured,
 * a `taskkill /F` on main alone takes the utility process and the whole tree
 * beneath it, so the rare catastrophic case is the one Windows already handles.
 *
 * **The ordinary supervised kill was the leaky one**, and it is the common case:
 * every restart, every shutdown. `terminateTree` after `child.kill()` is
 * *indistinguishable from not calling it*, because `taskkill /T` walks the tree
 * by parent, and once the parent has exited there is no tree left to walk. The
 * call was there and did nothing. That is why `terminateHostTree` exists rather
 * than two statements a caller is trusted to keep in order.
 *
 * One layer is covered without help: Pi's own tool child. Pi spawns it with
 * `detached: process.platform !== "win32"`, so on Windows it is an ordinary
 * child and dies with the host in every case above. What escapes is anything
 * *that* process starts — a background server, a watcher, a detached build.
 *
 * ## What is still not guaranteed
 *
 * Kill-on-job-close. A Windows Job Object with
 * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` would cover the case no supervisor can —
 * main dying without running any code at all — and it needs a native addon to
 * create, which this project's Bun-only toolchain does not have. The measurement
 * above is what makes that acceptable rather than merely deferred: the case a
 * job object would add is the one Windows was already observed to handle.
 *
 * On POSIX the guarantee is weaker and is reported as such. Pi spawns tools
 * `detached: true` there, which puts each tool in *its own* process group rather
 * than the host's — so the negative-pid kill below reaches the host's group and
 * not the tool's. Closing that needs a descendant walk, and shipping one that
 * cannot be run on the machine this is developed and gated on would be a claim
 * rather than a fix. `processTreeCleanup` reports false off Windows for exactly
 * this reason.
 */

/**
 * Kills the host and everything under it, in the only order that works.
 *
 * The tree must be taken *before* the host is, and the ordering is the whole
 * function: a caller that inlines these two steps has a one-in-two chance of
 * writing the version that silently does nothing. `host.ts` had the wrong one.
 *
 * `pid` is undefined when the utility process has not spawned yet —
 * `UtilityProcess.pid` is not assigned until it does — in which case there are
 * no descendants to walk and killing is all there is to do. That case is worth
 * naming because a `taskkill /PID undefined` fails in a way that reads exactly
 * like a tree that was already clean.
 *
 * The host is killed even if the tree walk throws. A supervisor that left a live
 * host behind because cleanup failed would turn a leaked subprocess into a
 * leaked everything.
 */
export const terminateHostTree = async (
  pid: number | undefined,
  kill: () => void,
  /** Injected by tests, so the ordering can be observed without killing processes. */
  options: { terminate?: (pid: number) => Promise<void> } = {},
): Promise<void> => {
  const terminate = options.terminate ?? terminateTree
  try {
    if (pid !== undefined) await terminate(pid)
  } finally {
    kill()
  }
}

export const terminateTree = async (pid: number, graceMs = 3_000): Promise<void> => {
  if (process.platform === "win32") {
    // Walks the tree from the parent, so it must run while the parent is still
    // there to be walked from. See the table above for what happens otherwise.
    await run("taskkill", ["/PID", String(pid), "/T", "/F"])
    return
  }

  // Negative pid addresses the process group, which catches a shell's own
  // children. It does not catch a tool Pi started detached, which is in a group
  // of its own; that is the POSIX gap recorded above.
  try {
    process.kill(-pid, "SIGTERM")
  } catch {
    return
  }
  await delay(graceMs)
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    // Already gone, which is the outcome we wanted.
  }
}

const run = (command: string, args: string[]): Promise<void> =>
  new Promise((resolve) => execFile(command, args, () => resolve()))

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
