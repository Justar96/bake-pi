/**
 * Can Electron's three runtimes be timed against each other?
 *
 * Bake Pi runs in three processes and the interesting latencies all cross
 * between them: a command leaves the renderer and is answered by the agent host,
 * an event is emitted by the host and applied by the renderer. Every one of
 * those numbers is a subtraction between two clocks, and the subtraction is
 * meaningless unless the clocks agree.
 *
 * They are not obviously going to. `performance.now()` is monotonic but its
 * origin is per-process, so a delta between two processes' readings is a
 * difference between two unrelated zeroes. `Date.now()` shares a wall clock but
 * moves in whole milliseconds, which cannot describe the delays worth chasing.
 * The candidate is `performance.timeOrigin + performance.now()` — wall-anchored
 * like the first, fine-grained like the second — and whether that composition
 * survives Chromium's timer coarsening and three separate time origins is a
 * question about Electron rather than about arithmetic.
 *
 * So it is measured, in the real topology: Electron main, a real
 * `utilityProcess`, and a real sandboxed Chromium renderer.
 *
 * ## Run on demand, and gated on nothing
 *
 * This is a recorded answer rather than a gate, because **nothing in Bake Pi
 * currently subtracts one process's clock from another's.** Every duration the
 * timings module reports is taken inside a single process, which needs no
 * agreement at all. Wiring this into `verify` would gate the build on a fact no
 * code depends on. It exists for the day something does.
 *
 * ## The answer
 *
 * They do not agree exactly, and the first version of this script called that a
 * failure. It was asking the wrong question. Each process anchors its own time
 * origin from the wall clock at its own start, and then advances on a monotonic
 * clock, so the clocks differ by a fixed amount. What matters is how big.
 *
 * Measured on Electron 44: the agent host reads about 288 us behind main and the
 * renderer about 543 us ahead of it, so the two ends of the event stream differ
 * by roughly 830 us. Those offsets are stable across a run — single-digit
 * microseconds of spread, and no drift worth reporting. The renderer's clock is
 * coarsened to 100 us, which is Chromium doing that to a context that is not
 * cross-origin isolated, and is far finer than anything here needs.
 *
 * ## What it does not license, which is most of what would matter
 *
 * This run is seconds long, undisturbed, and taken from processes that all
 * started moments earlier. Every way the arithmetic actually breaks is outside
 * it:
 *
 * - **The agent host restarts.** That is what the whole supervisor exists for.
 *   A host started hours into a session re-anchors its time origin to a wall
 *   clock that has been disciplined since main read it, and inherits the whole
 *   correction as silent skew.
 * - **Suspend and resume.** Node and Chromium do not contractually agree on
 *   whether time spent suspended is counted. One closed lid can inject a
 *   permanent skew the length of the nap, and a desktop application lives
 *   through suspends.
 * - **A stepped wall clock.** The monotonic clock is not disciplined; the wall
 *   anchor was. An NTP step lands entirely on the difference between them.
 *
 * So the claim this run supports is exactly: *three freshly started Electron
 * processes on one machine agree to under a millisecond over a short,
 * undisturbed window.* It does not support trusting a cross-process subtraction
 * in a long-lived session, and a design that needs one should estimate the
 * offset at runtime — ping and pong over a channel that already exists, yielding
 * an offset with an uncertainty attached, re-estimated after every restart —
 * rather than trusting these anchors.
 *
 * One estimator detail, since it decides the numbers above. The offset is
 * estimated as the peer's reading minus the midpoint of the window it was taken
 * in, which is what a time protocol does and assumes the two legs of the
 * exchange cost about the same. Where they do not, the estimate is wrong by half
 * the asymmetry — bounded by the window, which is reported alongside it.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const fixture = join(root, "scripts/fixtures/clock-probe")
const TIMEOUT_MS = 120_000

const electronBinaryFor = (platform: NodeJS.Platform): string => {
  switch (platform) {
    case "win32":
      return join(root, "node_modules/electron/dist/electron.exe")
    case "darwin":
      return join(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
    default:
      return join(root, "node_modules/electron/dist/electron")
  }
}

const electronBinary = electronBinaryFor(process.platform)

interface Sample {
  beforeWall: number
  peerWall: number
  afterWall: number
}

interface PeerReport {
  samples: Sample[]
  resolutionWall: number
  resolutionDate: number
}

interface Report {
  ok: boolean
  error?: string
  electron: string
  chrome: string
  node: string
  host?: PeerReport
  renderer?: PeerReport
}

interface Verdict {
  /** Median estimated offset: how far ahead of us the peer's clock reads. */
  offsetMs: number
  /** How much that estimate moved across the run. Stable means calibratable. */
  spreadMs: number
  driftMs: number
  tightestWindowMs: number
  medianWindowMs: number
}

/**
 * Estimates the peer's clock offset the way a time protocol does.
 *
 * The peer stamped once, between two readings of ours, so the best estimate of
 * its offset is its reading minus the midpoint of our window. That assumes the
 * two legs of the exchange take about the same time; where they do not, the
 * estimate is wrong by half the asymmetry, which the window width bounds.
 *
 * This replaced a plain inclusion test — is the peer's reading inside our
 * window? — which answered the wrong question. Inclusion asks whether the clocks
 * agree *perfectly*, and the useful question is by how much they differ, because
 * a difference that is stable can be subtracted and a difference far below the
 * smallest interval worth measuring does not need to be.
 */
const judge = (samples: readonly Sample[]): Verdict => {
  const offsets = samples.map((sample) => sample.peerWall - (sample.beforeWall + sample.afterWall) / 2)
  const windows = samples.map((sample) => sample.afterWall - sample.beforeWall)

  const middle = (values: readonly number[]): number => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)] ?? 0
  }
  const third = Math.floor(offsets.length / 3)
  const sortedOffsets = [...offsets].sort((a, b) => a - b)
  const sortedWindows = [...windows].sort((a, b) => a - b)

  return {
    offsetMs: middle(offsets),
    // The interquartile spread rather than min-to-max: a single scheduling
    // stall would otherwise be reported as clock instability.
    spreadMs:
      (sortedOffsets[Math.floor(offsets.length * 0.75)] ?? 0) - (sortedOffsets[Math.floor(offsets.length * 0.25)] ?? 0),
    driftMs: middle(offsets.slice(-third)) - middle(offsets.slice(0, third)),
    tightestWindowMs: sortedWindows[0] ?? 0,
    medianWindowMs: sortedWindows[Math.floor(sortedWindows.length / 2)] ?? 0,
  }
}

const micro = (ms: number): string => `${(ms * 1000).toFixed(1)} us`

const describe = (name: string, peer: PeerReport): string[] => {
  const wall = judge(peer.samples)
  return [
    `${name}`,
    `  clock offset from main     ${micro(wall.offsetMs)}`,
    `  spread of that estimate    ${micro(wall.spreadMs)}`,
    `  drift, first third to last ${micro(wall.driftMs)}`,
    `  exchange window            ${micro(wall.tightestWindowMs)} tightest, ${micro(wall.medianWindowMs)} median`,
    `  its clock resolution       wall ${micro(peer.resolutionWall)}, Date.now() ${micro(peer.resolutionDate)}`,
  ]
}

/**
 * How far apart two clocks may read before a latency built on them is a lie.
 *
 * Not zero, and the reason is what the budgets are denominated in. The finest
 * interval Bake Pi has committed to measuring is a 100 ms frame; the tightest is
 * a 150 ms first-token overhead. A clock offset of a millisecond is under one
 * percent of the smallest of those, which is noise against what it is being used
 * to judge. Demanding perfect agreement would fail a design that is in fact
 * accurate enough, and claiming microsecond precision from it would be the
 * overclaim in the other direction.
 */
const TOLERABLE_OFFSET_MS = 5
/** A clock that cannot express a tenth of a millisecond cannot describe a turn. */
const TOLERABLE_RESOLUTION_MS = 0.5

const workDir = mkdtempSync(join(tmpdir(), "bakepi-clocks-"))
const reportPath = join(workDir, "clocks.json")

try {
  const built = await Bun.build({
    entrypoints: [join(fixture, "main.ts")],
    target: "node",
    format: "cjs",
    external: ["electron"],
  })
  if (!built.success) throw new Error(`could not build the probe: ${built.logs.join("\n")}`)
  writeFileSync(join(workDir, "main.js"), await built.outputs[0]!.text(), "utf8")
  writeFileSync(join(workDir, "host.js"), readFileSync(join(fixture, "host.js"), "utf8"), "utf8")
  writeFileSync(join(workDir, "package.json"), JSON.stringify({ name: "clock-probe", main: "main.js" }), "utf8")
  // The renderer needs a document to be a renderer. Nothing in it matters; the
  // clock being measured belongs to the process, not to the page.
  writeFileSync(join(workDir, "index.html"), "<!doctype html><title>clock probe</title>", "utf8")

  const child = Bun.spawn([electronBinary, workDir], {
    env: { ...process.env, PROBE_OUT: reportPath },
    stdout: "ignore",
    stderr: "ignore",
  })

  // Cancelled on the winning path. A pending timer keeps Bun's loop alive, which
  // is how the smoke script once appeared to hang after it had already passed.
  let watchdog: ReturnType<typeof setTimeout> | undefined
  const exited = await Promise.race([
    child.exited,
    new Promise<"timeout">((resolve) => {
      watchdog = setTimeout(() => resolve("timeout"), TIMEOUT_MS)
    }),
  ]).finally(() => clearTimeout(watchdog))

  if (exited === "timeout") {
    child.kill()
    throw new Error(`the probe did not finish within ${String(TIMEOUT_MS / 1000)}s`)
  }

  const report = JSON.parse(readFileSync(reportPath, "utf8")) as Report
  if (!report.ok) throw new Error(report.error ?? "the probe reported failure")
  if (report.host === undefined || report.renderer === undefined) throw new Error("the probe reported no samples")

  console.log(`electron ${report.electron}  chromium ${report.chrome}  node ${report.node}`)
  for (const line of describe("agent host (utilityProcess, Node)", report.host)) console.log(line)
  for (const line of describe("renderer (sandboxed Chromium)", report.renderer)) console.log(line)

  const failures: string[] = []
  for (const [name, peer] of [
    ["agent host", report.host],
    ["renderer", report.renderer],
  ] as const) {
    const verdict = judge(peer.samples)
    if (Math.abs(verdict.offsetMs) > TOLERABLE_OFFSET_MS) {
      failures.push(
        `${name}: its clock reads ${micro(verdict.offsetMs)} from main's, beyond the ${String(TOLERABLE_OFFSET_MS)} ms a latency built on it can absorb`,
      )
    }
    // A stable offset can be calibrated away; one that wanders cannot, and a
    // number derived from a wandering clock is wrong in a way nothing downstream
    // can detect.
    if (Math.abs(verdict.driftMs) > TOLERABLE_OFFSET_MS) {
      failures.push(`${name}: its offset moved ${micro(verdict.driftMs)} across one short run, so it is not stable`)
    }
    if (peer.resolutionWall > TOLERABLE_RESOLUTION_MS) {
      failures.push(`${name}: its wall clock moves in ${micro(peer.resolutionWall)} steps, too coarse to time a turn`)
    }
  }

  for (const failure of failures) console.error(`clocks: ${failure}`)
  if (failures.length > 0) process.exitCode = 1
  else console.log("clocks ok")
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
