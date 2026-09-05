/**
 * `REC-001`: does killing the agent host leave a tool's descendants running?
 *
 * This cannot be a unit test and it cannot be answered by reading. It needs a
 * real Electron process, a real `utilityProcess`, a real tool subprocess, and a
 * process that tool itself started — and then it needs to look at the operating
 * system rather than at anything the application says about itself.
 *
 * Two runs, and the second is what makes the first mean something:
 *
 * 1. **The supervisor's real ordering.** Nothing under the host may survive.
 * 2. **The ordering the supervisor used to have** — kill, then walk the tree.
 *    Something under the host *must* survive, because if it does not, the run
 *    above proves only that Windows cleans up on its own and the assertion is a
 *    tautology.
 *
 * The counterfactual is not decoration. Every earlier version of this
 * measurement passed while measuring nothing: one had a tool that died on its
 * own, one read `UtilityProcess.pid` before the process had spawned so the tree
 * walk silently never ran, and one observed the tree before the kill had
 * happened. Each looked like a clean result.
 *
 * The run is also timed, because Milestone 3 budgets graceful shutdown at
 * "under 2 seconds, without supported-case orphans" and this script already
 * proves the second half against the real topology. `watchShutdown` below states
 * exactly which two instants the printed number spans, and — as importantly —
 * which parts of the supervisor's stop path are not inside it.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const fixture = join(root, "scripts/fixtures/orphan-probe")

if (process.platform !== "win32") {
  // Not a pass. Pi spawns tools `detached: true` off Windows, which puts each in
  // its own process group rather than the host's, so the negative-pid kill in
  // `process-group.ts` does not reach them and the guarantee is known to be
  // weaker. Claiming a pass here would be the exact overclaim `REC-001` is
  // about. `processTreeCleanup` reports false on this platform.
  console.log(`orphans skipped: unmeasured on ${process.platform}; the Windows guarantee is the one claimed`)
  process.exit(0)
}

const electronBinary = join(root, "node_modules/electron/dist/electron.exe")

interface Report {
  mainPid: number
  hostPid: number
  toolPid: number
}

const powershell = async (command: string): Promise<string> => {
  const child = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", command], {
    stdout: "pipe",
    stderr: "ignore",
  })
  return (await new Response(child.stdout).text()).trim()
}

const alive = async (pid: number): Promise<boolean> =>
  (await powershell(`if (Get-Process -Id ${String(pid)} -ErrorAction SilentlyContinue) { "y" } else { "n" }`)) === "y"

const childrenOf = async (pid: number): Promise<number[]> => {
  const listed = await powershell(
    `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${String(pid)}" | Select-Object -ExpandProperty ProcessId) -join ","`,
  )
  return listed.split(",").filter(Boolean).map(Number)
}

const killTree = async (pid: number): Promise<void> => {
  await Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" }).exited
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A sanity ceiling, and deliberately not the budget.
 *
 * Milestone 3 budgets graceful shutdown at 2 s *on the named minimum machine*,
 * and the machine this usually runs on is not that one. A shared CI runner
 * hands a `taskkill /T` over a four-process tree whatever CPU is left over from
 * every other job on the box, and the spread between two runs there is larger
 * than the budget itself; gating on 2 s would fail runs that say nothing about
 * the kill path. An order of magnitude out is chosen so that what trips this is
 * a kill path that has genuinely stopped working — a tree walk that retries, a
 * `taskkill` blocked on a handle nobody releases, a host that no longer exits
 * when killed — and never a busy afternoon. The budget is checked by reading the
 * number printed below, on the machine the budget names.
 */
const SHUTDOWN_SANITY_CEILING_MS = 20_000

interface ShutdownTiming {
  /** Stop entered, to the host process observed gone by its own parent. */
  hostGone: number | undefined
  /** Stop entered, to the supervisor's kill path returning. */
  stopReturned: number
}

/**
 * How long the supervisor's kill path took, timed from outside it.
 *
 * "Shutdown took N ms" means nothing until N's two ends are named, so they are
 * named here, and the naming is the load-bearing part of this function.
 *
 * **Start — the stop request being issued.** The first read of the probe's log
 * in which a line *begins* `pid=`. The fixture's main writes that line as its
 * last statement before it enters the kill path, so it stands for the request.
 * The anchor is not incidental: the fixture also logs `host spawned pid=…` when
 * the utility process spawns, before the readiness check, and an unanchored match
 * would start the stopwatch at the fork and report the fixture's own wait as
 * shutdown — a wrong number that looks entirely plausible.
 *
 * **End — the host actually being gone.** The first read in which a line begins
 * `host exited `, written from the `exit` event Electron raises when the utility
 * process is no longer running. That is the closest thing to "gone" anyone
 * observes: the parent noticing the child is not there any more.
 *
 * One leg does come apart from where this script stands, and it is worth having.
 * `killed`, written on the statement after `terminateHostTree` resolves, marks
 * the point where the supervisor's stop *returns* — the tree walked and the
 * child killed. The host dying and the stop path finishing are different
 * instants, and a shutdown that has gone wrong will usually separate them.
 *
 * Every one of those instants is a `performance.now()` reading taken in *this*
 * process. The durations cross a process boundary; no timestamp does, and no
 * clock is ever subtracted from another's. Monotonic rather than `Date.now()`
 * because a wall clock can be stepped underneath a running measurement, and
 * these are durations rather than times of day.
 *
 * Two things this number is not, both of which a reader would otherwise assume.
 *
 * It does not separate the tree walk from the kill. `terminateHostTree` walks
 * the tree and then kills the child, and the fixture writes nothing between
 * them, so from out here they are one interval. Splitting them needs the fixture
 * to time its own two legs and report the durations — measured inside main and
 * carried out as numbers, which is allowed — and the fixture is not this file.
 *
 * It is not the whole of `UtilityProcessLauncher.stop`. That path first sends a `shutdown`
 * command and races it against two seconds, and only then walks the tree. The
 * probe deliberately has no contract, no Pi and no command channel, so it never
 * sends one and that leg contributes nothing here. The 2 s budget covers all
 * three legs; this covers the last two, which is why the printed output says so
 * rather than leaving the budget looking satisfied.
 *
 * Resolution is the poll interval at each end, so a leg shorter than one poll
 * reads as zero. A read that catches the log mid-append matches nothing — every
 * pattern needs the newline the appended line ends with — and matches on the
 * next pass instead, which is why torn reads need no other handling.
 */
const watchShutdown = (logPath: string, timeoutMs: number): { result: Promise<ShutdownTiming>; cancel: () => void } => {
  const POLL_MS = 25
  // How long to keep waiting for the host's `exit` event after the stop path has
  // already returned. Electron delivers that event on its own schedule, and it
  // usually lands while `terminateHostTree` is still awaiting `taskkill` — but
  // it is not ordered against the return, and hanging the whole script on an
  // event that is only ever a diagnostic here would trade a measurement for a
  // timeout. Past this, the leg is reported missing instead.
  const EXIT_GRACE_MS = 2_000

  let timer: ReturnType<typeof setTimeout> | undefined
  let cancelled = false

  const result = new Promise<ShutdownTiming>((resolve, reject) => {
    const deadline = performance.now() + timeoutMs
    let enteredAt: number | undefined
    let hostGoneAt: number | undefined
    let stopReturnedAt: number | undefined

    const poll = (): void => {
      if (cancelled) return
      const now = performance.now()
      const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : ""

      // The log is append-only, so a byte offset is a causal order and can be
      // used as one. The host's exit counts as part of the shutdown only if it
      // was recorded after the request; a host that had already died of its own
      // accord would otherwise latch a mark that precedes the stopwatch and be
      // reported as a shutdown of zero, or of a negative number, depending on
      // which poll happened to notice which line first.
      const requestedAt = log.search(/^pid=/m)
      const exitedAt = log.search(/^host exited /m)

      if (enteredAt === undefined && requestedAt >= 0) enteredAt = now
      if (hostGoneAt === undefined && requestedAt >= 0 && exitedAt > requestedAt) hostGoneAt = now
      if (stopReturnedAt === undefined && /^killed$/m.test(log)) stopReturnedAt = now

      if (stopReturnedAt !== undefined && (hostGoneAt !== undefined || now - stopReturnedAt > EXIT_GRACE_MS)) {
        // A stop that was observed finishing but never observed starting is a
        // broken instrument rather than a fast shutdown, and reporting the one
        // as the other is how a measurement of nothing passes. This watcher is
        // started before Electron is, so the only way here is a fixture whose
        // marks have changed.
        if (enteredAt === undefined) {
          reject(new Error("the probe reached its kill path without the mark this script times from"))
          return
        }
        resolve({
          hostGone: hostGoneAt === undefined ? undefined : hostGoneAt - enteredAt,
          stopReturned: stopReturnedAt - enteredAt,
        })
        return
      }

      if (now > deadline) {
        reject(new Error(`the probe never finished its kill path within ${String(timeoutMs / 1000)}s`))
        return
      }
      timer = setTimeout(poll, POLL_MS)
    }

    poll()
  })

  /**
   * Cancellation exists for the same reason `scripts/smoke.ts` clears its
   * watchdog: a pending timer keeps Bun's event loop alive, so a run that
   * throws out of an assertion while this is still polling would sit there
   * until the deadline before reporting the failure it already knew about.
   */
  return {
    result,
    cancel: () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}

/** Runs one scenario and reports what was still alive after the host was killed, and how long the kill took. */
const measure = async (
  order: "correct" | "wrong",
): Promise<{ tool: boolean; descendants: boolean[]; shutdown: ShutdownTiming }> => {
  const workDir = mkdtempSync(join(tmpdir(), "bakepi-orphans-"))
  const reportPath = join(workDir, "probe.json")
  const logPath = join(workDir, "probe.log")

  // The fixture's main imports the real `process-group.ts`, so the ordering
  // under test is the shipped one rather than a copy of it.
  const built = await Bun.build({
    entrypoints: [join(fixture, "main.ts")],
    target: "node",
    format: "cjs",
    external: ["electron"],
  })
  if (!built.success) throw new Error(`could not build the probe: ${built.logs.join("\n")}`)
  writeFileSync(join(workDir, "main.js"), await built.outputs[0]!.text(), "utf8")
  writeFileSync(join(workDir, "host.js"), readFileSync(join(fixture, "host.js"), "utf8"), "utf8")
  writeFileSync(join(workDir, "package.json"), JSON.stringify({ name: "orphan-probe", main: "main.js" }), "utf8")

  const electron = Bun.spawn([electronBinary, workDir], {
    env: { ...process.env, PROBE_OUT: reportPath, PROBE_LOG: logPath, PROBE_ORDER: order },
    // Electron is a GUI-subsystem binary on Windows and writes nothing useful to
    // a pipe, so the probe's own log file is the diagnostic channel.
    stdout: "ignore",
    stderr: "ignore",
  })

  // Started before Electron has booted, rather than once the report file has
  // appeared. The fixture marks the stop only after our authorization, but the
  // watcher must already be running then: starting it after the signal could
  // miss the beginning and report a shutdown faster than the one that happened.
  // Watching an absent file costs an `existsSync` every 25 ms and keeps both
  // ends of the measured span independent of the readiness queries below.
  const shutdown = watchShutdown(logPath, 60_000)

  try {
    const deadline = Date.now() + 30_000
    while (!existsSync(reportPath)) {
      if (Date.now() > deadline) {
        const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "(the probe wrote no log)"
        throw new Error(`the probe host never reported
${log.slice(0, 4_000)}`)
      }
      await delay(200)
    }
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Report
    let descendants = await childrenOf(report.toolPid)
    while (descendants.length === 0 && Date.now() < deadline) {
      if (!(await alive(report.toolPid))) throw new Error("the probe tool exited before starting its descendants")
      await delay(25)
      descendants = await childrenOf(report.toolPid)
    }

    // The control. A tool that was never running reads as "cleaned up" in every
    // scenario, which is how a measurement of nothing passes.
    if (!(await alive(report.toolPid))) throw new Error("the probe tool was not running before the kill")
    if (descendants.length === 0) throw new Error("the probe tool started nothing, so there is nothing to measure")

    // Only the successful controls authorize a kill. A slow process query must
    // extend setup, not race a fixture timer and inspect an already-dead tool.
    writeFileSync(`${reportPath}.stop`, "stop", "utf8")

    // The fixture kills on this signal and stays alive afterwards, because main
    // exiting takes the whole tree with it and would mask the result. Waiting
    // for the kill to be reported rather than sleeping past it means the settle
    // window below starts after the kill instead of overlapping it, so the tree
    // is observed no earlier than it was before this script kept time.
    const timing = await shutdown.result
    await delay(8_000)
    if (!(await alive(report.mainPid))) throw new Error("the probe main exited before the tree could be observed")

    const stillAlive: boolean[] = []
    for (const pid of descendants) stillAlive.push(await alive(pid))
    const result = { tool: await alive(report.toolPid), descendants: stillAlive, shutdown: timing }

    await killTree(report.mainPid)
    for (const pid of descendants) await killTree(pid)
    return result
  } finally {
    shutdown.cancel()
    electron.kill()
    rmSync(workDir, { recursive: true, force: true })
  }
}

const correct = await measure("correct")
if (correct.tool || correct.descendants.some(Boolean)) {
  throw new Error(
    `the supervisor's kill left processes running: tool=${String(correct.tool)} descendants=${JSON.stringify(correct.descendants)}`,
  )
}

const wrong = await measure("wrong")
if (!wrong.descendants.some(Boolean)) {
  throw new Error(
    "killing the host before walking its tree left nothing behind, so the run above proves nothing about the ordering",
  )
}

/**
 * Only the correct-order run is reported.
 *
 * The counterfactual kills the host first and then walks a tree that no longer
 * has a parent to be walked from, which is fast for the same reason it is wrong.
 * Printing its duration beside the real one would invite the comparison, and the
 * comparison says only that doing less takes less time.
 */
const LEGS: readonly (readonly [keyof ShutdownTiming, string])[] = [
  ["hostGone", "stop requested, to the host process gone (budget: 2 s)"],
  ["stopReturned", "stop requested, to the tree walked and the kill path returned"],
]

console.log("orphans ok")
console.log("  supervised kill left no tool process and no descendant of one")
console.log("  kill-before-walk left a descendant, so the ordering is what did it")
for (const [key, description] of LEGS) {
  const value = correct.shutdown[key]
  // Missing rather than skipped, following `scripts/smoke.ts`: a leg that is
  // absent is a leg whose two marks were not both reached, which is a finding.
  console.log(`  ${value === undefined ? "  ----" : value.toFixed(0).padStart(6)} ms  ${description}`)
}
console.log("             the budget covers all three legs of stop; the shutdown command's 2 s race is not")
console.log("             in these numbers, because the probe carries no command channel to send one on")

const overruns = LEGS.flatMap(([key, description]) => {
  const value = correct.shutdown[key]
  if (value === undefined || value <= SHUTDOWN_SANITY_CEILING_MS) return []
  return [
    `${description} took ${(value / 1000).toFixed(1)}s, past the ${String(SHUTDOWN_SANITY_CEILING_MS / 1000)}s that means the kill path is broken rather than the machine busy`,
  ]
})
// Thrown rather than `process.exit`, and uniformly with every other failure in
// this script. `measure` cleans up its temporary directory, its polling timer
// and its Electron process in a `finally`, which `process.exit` walks straight
// past; a failure this late happens to have nothing outstanding, but a rule that
// holds only where the author checked is one the next edit breaks.
if (overruns.length > 0) throw new Error(overruns.join("; "))
