/**
 * Launches the packaged-shape application and asserts it came up.
 *
 * This is the integration test the unit suites cannot be: it starts a real
 * Electron process, loads the real preload into a real sandboxed renderer,
 * forks the real utility process, and requires Pi to load and answer a
 * handshake. Everything it covers fails silently otherwise — a broken preload
 * bundle, a scheme registered too late, an agent host that cannot resolve Pi,
 * and an ESM main that deadlocks on `app.whenReady()` all present as a window
 * that never paints and no error anywhere.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { APP_SCHEME, IMAGE_HOST } from "@bake-pi/contract"

/*
 * Rebuilt from the contract rather than imported from main.
 *
 * `IMAGE_ORIGIN` lives in `main/protocol.ts`, which imports `electron` at module
 * scope — importing it here would fail before the first assertion ran. The two
 * halves of the origin come from the contract, which is runtime-neutral, so this
 * still cannot drift from what the CSP names.
 */
const IMAGE_ORIGIN = `${APP_SCHEME}://${IMAGE_HOST}`

const root = join(import.meta.dir, "..")
const TIMEOUT_MS = 90_000

const electronBinary =
  process.platform === "win32"
    ? join(root, "node_modules/electron/dist/electron.exe")
    : process.platform === "darwin"
      ? join(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
      : join(root, "node_modules/electron/dist/electron")

const workDir = mkdtempSync(join(tmpdir(), "bakepi-smoke-"))
const reportPath = join(workDir, "smoke.json")

interface StartupTimings {
  nativeLaunch?: number
  toReady?: number
  toWindowLoaded?: number
  toHostReady?: number
  toConnected?: number
  toUsable?: number
  coldStart?: number
  hostLaunch?: number
  hostModule?: number
  hostRuntime?: number
}

/**
 * How long stopping took, split by what could have been slow. Reported here
 * rather than by `bun run orphans`, which drives the tree termination directly
 * and has no command channel — so the leg that dominates the two-second budget,
 * asking the host to finish, never runs there.
 */
interface ShutdownTimings {
  requested: number
  walked: number
  total: number
  acknowledged: boolean
}

/**
 * Which of the two ways to colour a syntax token the real policy allows.
 *
 * `cssom` is what React's `style` prop does and what the conversation renderer
 * relies on; `parser` is what `innerHTML` with a `style="…"` attribute does,
 * which is how every Shiki-based renderer — `@pierre/diffs` included — emits
 * colour. The application depends on the first working and the second not, so
 * both are measured rather than assumed.
 */
interface StylePolicy {
  cssom: string
  parser: string
  evaluate: string
  violatedDirectives: string[]
}

interface SmokeReport {
  ok: boolean
  rendererReady?: boolean
  eventIntake?: boolean
  stylePolicy?: StylePolicy
  imageOrigin?: { appImagesBlocked: boolean; foreignImagesBlocked: boolean }
  error?: string
  piVersion?: string
  nodeVersion?: string
  contractVersion?: number
  electron?: string
  chrome?: string
  fonts?: FontLoad[]
  startup?: StartupTimings
  shutdown?: ShutdownTimings
}

interface FontLoad {
  family: string
  matches: number
  ready: boolean
  error?: string
  registered: string[]
}

/**
 * Sanity ceilings, and deliberately not the budgets.
 *
 * Milestone 3 budgets cold start at 2.5 s and the handshake at 1 s, "on the
 * named minimum machine". A hosted CI runner is not that machine, and wall-clock
 * latency there varies severalfold between runs on shared hardware — asserting
 * the real budget here would manufacture a flaky gate that says nothing about
 * the product. These thresholds are set an order of magnitude out, so they catch
 * a launch that has genuinely broken — a protocol handler falling back to a
 * timeout, a host retrying a failed Pi resolution — and nothing else. The
 * budgets are asserted on the named machine, by reading the numbers this prints.
 */
const SANITY_CEILINGS: Record<string, number> = {
  coldStart: 30_000,
  toUsable: 30_000,
  toHostReady: 20_000,
}

/**
 * Shutdown's ceiling is the one that cannot be an order of magnitude out.
 *
 * `UtilityProcessLauncher.stop` races the `shutdown` command against a two-second timer, so a
 * host that never answers costs almost exactly the two seconds the budget
 * allows, and a ceiling above that would pass a host that hung every single
 * time. The ceiling sits above the race so that a slow-but-answering host does
 * not fail CI, and the `acknowledged` flag — not the duration — is what
 * distinguishes a host that stopped from one that was killed mid-sentence.
 */
const SHUTDOWN_SANITY_CEILING_MS = 15_000

const LEGS: readonly (readonly [keyof StartupTimings, string])[] = [
  ["nativeLaunch", "electron bootstrap, before any of our JavaScript"],
  ["toReady", "our entry module, to app ready"],
  ["toWindowLoaded", "app ready, to a window with its document"],
  ["coldStart", "process creation to a loaded window (budget: 2.5 s)"],
  ["toHostReady", "agent host fork to hello_ack (budget: 1 s)"],
  ["hostLaunch", "  of which: electron spawning the process and node booting"],
  ["hostModule", "  of which: the host's own bundle evaluating"],
  ["hostRuntime", "  of which: building the Pi runtime"],
  ["toConnected", "process creation to the host event channel being connected"],
  ["toUsable", "process creation to the connected interface becoming usable"],
]

try {
  const child = Bun.spawn([electronBinary, `--user-data-dir=${join(workDir, "profile")}`, join(root, "apps/desktop")], {
    env: { ...process.env, BAKE_PI_SMOKE_OUT: reportPath },
    // Electron is a GUI-subsystem binary on Windows and writes nothing useful
    // to a pipe. The report file is the channel.
    stdout: "ignore",
    stderr: "pipe",
  })

  /**
   * The watchdog is cancelled on the winning path, and that `clearTimeout` is
   * the whole point of writing it out rather than racing `Bun.sleep`.
   *
   * `Promise.race` settles on the first result but does not cancel the loser, so
   * a raced `Bun.sleep(TIMEOUT_MS)` leaves a live timer behind. Bun keeps its
   * event loop alive while a timer is pending, so the script printed `smoke ok`
   * and then sat there for the remaining timeout before exiting 0. That looked
   * exactly like a hung smoke test and made `bun run verify` unusable as a gate
   * for something that had, in fact, already succeeded.
   */
  let watchdog: ReturnType<typeof setTimeout> | undefined
  const exited = await Promise.race([
    child.exited,
    new Promise<"timeout">((resolve) => {
      watchdog = setTimeout(() => resolve("timeout"), TIMEOUT_MS)
    }),
  ]).finally(() => clearTimeout(watchdog))

  if (exited === "timeout") {
    child.kill()
    throw new Error(`the application did not exit within ${TIMEOUT_MS / 1000}s`)
  }

  const file = Bun.file(reportPath)
  if (!(await file.exists())) {
    const stderr = await new Response(child.stderr).text()
    throw new Error(`no smoke report was written (exit ${exited})\n${stderr.slice(0, 2_000)}`)
  }

  const report = (await file.json()) as SmokeReport
  if (!report.ok) throw new Error(`startup failed: ${report.error ?? "unknown"}`)
  if (report.rendererReady !== true) throw new Error("startup did not prove the renderer consumed the host event port")

  /*
   * The assertion `rendererReady` cannot make.
   *
   * A renderer marks itself connected on receiving the event port, so the
   * onboarding text above paints before any event has been validated. The
   * renderer's `script-src` forbids `new Function`, and the contract's
   * validators were once built with it, so every session event was dropped in
   * silence while this smoke reported a healthy start: no streamed tokens, no
   * snapshots, no tool cards, and not even a gap — the gap counter only
   * advances on an event that was accepted. Main drives one real envelope down
   * the real path at the end of startup and this is where the DOM at the far
   * end of it is required to have changed.
   */
  if (report.eventIntake !== true) {
    throw new Error("an event did not survive the renderer's intake under the policy; nothing would stream")
  }

  /*
   * The colour a token gets is an architectural decision, so it is asserted
   * rather than printed. If CSSOM ever stops applying, the conversation
   * renderer has silently gone monochrome. If the parser path ever starts
   * applying, `style-src` has quietly acquired `'unsafe-inline'` and the
   * reason for not adopting the library's own renderer no longer holds.
   */
  const policy = report.stylePolicy
  if (policy === undefined) throw new Error("the renderer never reported which style path the policy allows")
  if (policy.cssom !== "rgb(1, 2, 3)") {
    throw new Error(`a CSSOM style did not apply under the policy (computed ${policy.cssom}); syntax highlighting would render monochrome`)
  }
  if (policy.parser === "rgb(4, 5, 6)") {
    throw new Error("a parser-created style attribute applied, so style-src is no longer forbidding inline styles")
  }

  /*
   * What `img-src` is actually holding, measured rather than assumed.
   *
   * The remote load is the security half: an image block's URL is minted by
   * the host, but the timeline also renders model-authored markdown, and this
   * directive is what keeps a URL in it from reaching the network. That half
   * is enforced, so it is asserted.
   *
   * The app-scheme load is a canary, and the reason it is worth having is what
   * measuring it revealed: Chromium exempts a scheme registered through
   * `registerSchemesAsPrivileged` from this directive entirely, so an
   * app-scheme image loads even under `img-src 'none'`. That means a blocked
   * app image cannot happen today, and if it ever does — a Chromium that began
   * enforcing it, against a policy that had dropped the origin — every
   * attachment in every conversation would go blank with nothing in any log.
   * Which origins the policy admits is proved end to end by `bun run journey`,
   * which decodes a real attachment and reads its `naturalWidth`; this can
   * only prove the directive exists and is enforced against the network.
   */
  const imageOrigin = report.imageOrigin
  if (imageOrigin === undefined) throw new Error("the renderer never reported what img-src did with an image load")
  if (!imageOrigin.foreignImagesBlocked) {
    throw new Error("img-src did not block a remote image, so the directive is not being enforced at all")
  }
  if (imageOrigin.appImagesBlocked) {
    throw new Error(`img-src rejected ${IMAGE_ORIGIN}, so no image block will render — the privileged scheme is no longer exempt and the directive has to name that origin`)
  }

  const fontFailures = (report.fonts ?? []).flatMap((font) => {
    if (font.error !== undefined) return [`${font.family}: document.fonts.load rejected (${font.error})`]
    if (font.matches === 0) return [`${font.family}: document.fonts.load matched no @font-face rule (registered: ${font.registered.join(", ") || "none"})`]
    if (!font.ready) return [`${font.family}: document.fonts.check was false after loading`]
    return []
  })
  if ((report.fonts?.length ?? 0) !== 2) {
    fontFailures.push(`expected results for 2 faces, received ${String(report.fonts?.length ?? 0)}`)
  }
  if (fontFailures.length > 0) {
    throw new Error(`bundled renderer fonts did not load: ${fontFailures.join("; ")}`)
  }

  console.log("smoke ok")
  console.log(`  electron ${report.electron}  chromium ${report.chrome}  node ${report.nodeVersion}`)
  console.log(`  pi ${report.piVersion}  contract v${report.contractVersion}`)
  console.log(`  style-src: CSSOM applies, parser-created style attributes do not`)
  console.log(`  fonts: Geist Sans and Geist Mono loaded in the renderer`)
  console.log(`  img-src: a remote image is refused, ${IMAGE_ORIGIN} is not`)
  console.log(`  event intake: a real envelope validated in the renderer main world and reached the DOM`)
  console.log(`  script-src: new Function() is ${policy.evaluate}`)
  if (policy.violatedDirectives.length > 0) console.log(`  reported violations: ${policy.violatedDirectives.join(", ")}`)

  const startup = report.startup ?? {}
  for (const [key, description] of LEGS) {
    const value = startup[key]
    // Printed as missing rather than skipped. A leg that vanished is a leg whose
    // marks were not both reached, which is a finding rather than an absence.
    console.log(`  ${(value === undefined ? "  ---- " : `${value.toFixed(0).padStart(6)}`)} ms  ${description}`)
  }

  const shutdown = report.shutdown
  if (shutdown === undefined) {
    console.log("     ---- ms  graceful shutdown (the application never reported one)")
  } else {
    console.log(`  ${shutdown.total.toFixed(0).padStart(6)} ms  graceful shutdown (budget: 2 s)`)
    console.log(`  ${shutdown.requested.toFixed(0).padStart(6)} ms    of which: the shutdown command, raced against 2 s`)
    console.log(`  ${shutdown.walked.toFixed(0).padStart(6)} ms    of which: the ordered tree walk and the kill`)
    if (!shutdown.acknowledged) {
      console.log("             the host never answered the shutdown command; the race timed out")
    }
  }

  const overruns = Object.entries(SANITY_CEILINGS).flatMap(([key, ceiling]) => {
    const value = startup[key as keyof StartupTimings]
    if (value === undefined || value <= ceiling) return []
    return [`${key} took ${(value / 1000).toFixed(1)}s, past the ${String(ceiling / 1000)}s that means something is broken`]
  })
  if (shutdown !== undefined && shutdown.total > SHUTDOWN_SANITY_CEILING_MS) {
    overruns.push(`shutdown took ${(shutdown.total / 1000).toFixed(1)}s, past the ${String(SHUTDOWN_SANITY_CEILING_MS / 1000)}s that means something is broken`)
  }
  // A host that had to be killed is a finding regardless of how fast the killing
  // was. The budget is on *graceful* shutdown, and a two-second race that times
  // out every run would otherwise report a comfortable number for a host that
  // never once stopped when asked.
  if (shutdown !== undefined && !shutdown.acknowledged) {
    overruns.push("the host did not acknowledge the shutdown command, so this run measured a kill rather than a graceful stop")
  }

  for (const overrun of overruns) console.error(`smoke: ${overrun}`)
  // Thrown rather than `process.exit`, which would skip the `finally` below and
  // leave the temporary directory behind on exactly the runs that fail.
  if (overruns.length > 0) throw new Error(overruns.join("; "))
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
