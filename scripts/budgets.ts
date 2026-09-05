/**
 * What an open session costs, measured rather than assumed.
 *
 * The Milestone 2 criterion asks for session-count, resident-memory and
 * buffered-event limits that are *measured, documented, and enforced*. The
 * buffered-event limit was the easy one: it is a byte count the emitter applies
 * to a buffer it owns, and `emitter.test.ts` breaches it on purpose. The other
 * two cannot be settled that way. A session's cost is Pi's cost — a
 * `ModelRuntime` view, a services container, an extension set loaded through
 * jiti, subscriptions, and the whole message history held in memory — and none
 * of that is knowable from reading Bake Pi's own code.
 *
 * So this measures it, in a real process, against real Pi, with the same
 * provider fixture the vertical slice uses. It reports three numbers and checks
 * each against what `session/budget.ts` claims:
 *
 * 1. **Fixed cost per open session** — the marginal resident bytes of one more
 *    idle session that has taken one turn. This is what `MAX_OPEN_SESSIONS`
 *    divides the host's session budget by.
 * 2. **Variable cost per turn** — the marginal resident bytes of one more turn
 *    on a session already open. The count cap cannot bound this, which is why
 *    there is a memory ceiling as well as a count.
 * 3. **Host baseline** — what the runtime costs before any session exists, so
 *    the ceiling is not confused with the budget for sessions.
 *
 * Two things about the method are worth stating, because both were wrong in
 * earlier drafts of this script and both produced numbers that looked fine.
 *
 * The first session is excluded from the fixed-cost average. It pays for
 * everything Pi loads lazily on first use — extension resolution, jiti, the
 * tokenizer, provider client construction — and attributing that to "a session"
 * inflates the per-session figure several times over and would set the cap far
 * too low. The measurement wants the marginal session, so it measures from the
 * second one.
 *
 * And resident memory is sampled, not asked for. `Bun.gc(true)` is run before
 * every sample, because without it the figure is dominated by whatever the
 * allocator has not collected yet and drifts upward regardless of what the code
 * does. RSS still does not fall back cleanly when a session closes — allocators
 * do not return pages eagerly — which is itself a finding rather than a defect
 * in the measurement, and is the reason the ceiling refuses new work rather than
 * promising to recover from it.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Diagnostics } from "../packages/agent-host/src/diagnostics.ts"
import { EventEmitter } from "../packages/agent-host/src/emitter.ts"
import {
  HOST_BASELINE_CEILING_BYTES,
  HOST_MEMORY_CEILING_BYTES,
  MAX_OPEN_SESSIONS,
  MEASURED_DEEP_SESSION_BYTES,
  MEASURED_SESSION_BYTES,
  MEASURED_TURN_BYTES,
  SESSION_MEMORY_BUDGET_BYTES,
} from "../packages/agent-host/src/session/budget.ts"
import { createPiRuntime } from "../packages/agent-host/src/runtime.ts"
import { agentDirWith, startModelServer } from "../packages/agent-host/test/provider-fixture.ts"

/** Sessions measured after the first. Enough for an average that is not one sample. */
const MEASURED_SESSIONS = 8
/** Turns added to a single session, for the half a session count cannot bound. */
const MEASURED_TURNS = 40
/**
 * How much assistant text a measured turn carries.
 *
 * Not a token or two. A turn of a few words retains less than the allocator's
 * own noise between two samples, and the first version of this script measured
 * exactly that: a *negative* per-turn cost, which is not a finding about
 * sessions but about garbage collection. A turn in a coding session carries
 * code, diffs and tool output, so the measurement carries something of that
 * order and states the size it assumed rather than implying a turn is a turn.
 */
const TURN_TEXT_BYTES = 16 * 1024
const TURN_TEXT = "x".repeat(TURN_TEXT_BYTES)

const temporary: string[] = []

const megabytes = (bytes: number): string => `${(bytes / 1_048_576).toFixed(2)} MB`

/**
 * A figure, the total it came from, and the noisiest single sample behind it.
 *
 * The script used to print means alone, and every document in the repository
 * then quoted one as a constant - "a session costs about 1.8 MB fixed". Three
 * runs on one idle machine put the marginal session at 2.03 MB, 0.93 MB and
 * 0.30 MB, so a mean printed to two decimal places was claiming a precision the
 * method does not have, and this reports enough to see that.
 *
 * What it reports needs care, because the obvious thing is wrong. These samples
 * are consecutive differences of a running total, so they telescope: their mean
 * is exactly `(last - first) / count`, and only the two endpoints matter. The
 * per-sample range is therefore *not* an error bar on the mean - it is allocator
 * noise between two adjacent RSS reads, and individual samples come out negative
 * because of it. Printing it as a range beside the mean would suggest the mean
 * is uncertain by that much, which is a different and equally false claim.
 *
 * So this prints the total the mean divides, and the largest absolute single
 * sample as `noise`. Between them a reader can do the only inference that is
 * available: the mean's uncertainty is roughly the endpoint noise divided by the
 * sample count, which is why the declared limits in `session/budget.ts` sit well
 * above these figures rather than at them, and why moving a limit on the
 * strength of one run is not supported by this instrument. Raising
 * `MEASURED_SESSIONS` is what buys precision, at linear cost in runtime.
 */
interface Spread {
  mean: number
  total: number
  noise: number
}

const spreadOf = (values: readonly number[]): Spread => {
  const total = values.reduce((sum, value) => sum + value, 0)
  return {
    mean: total / values.length,
    total,
    noise: Math.max(...values.map((value) => Math.abs(value))),
  }
}

/** `mean  [total over n, noise ±x]` - the mean, what it divides, and what limits it. */
const withPrecision = (spread: Spread, count: number): string =>
  `${megabytes(spread.mean)}  [${megabytes(spread.total)} over ${String(count)}, noise ${String(Math.round(spread.noise / 1_048_576 * 10) / 10)} MB]`

/**
 * A resident-memory sample, after collection.
 *
 * `Bun.gc(true)` is synchronous and does collect; the sample is still an
 * estimate, because RSS includes pages the allocator holds and has not returned.
 * That upward bias is the safe direction for a ceiling.
 */
const resident = (): number => {
  Bun.gc(true)
  return process.memoryUsage.rss()
}

const main = async (): Promise<void> => {
  const server = await startModelServer()
  const agentDir = agentDirWith(server.baseUrl)
  temporary.push(agentDir)
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_OFFLINE = "1"
  process.env.PI_SKIP_VERSION_CHECK = "1"
  process.env.PI_TELEMETRY = "0"

  /** The one event this script reads: whether the turn it just asked for is over. */
  const idle = new Set<string>()
  const emitter = new EventEmitter()
  let acknowledge: ((event: { data: unknown }) => void) | undefined
  // Attached to a sink rather than left detached. A detached emitter buffers
  // every event up to its own cap, which would put the event buffer's bytes
  // inside the per-session figure and measure two limits as one.
  emitter.attach({
    postMessage: (message: unknown) => {
      const envelope = message as { name: string; sessionId?: string; payload: { status?: string } }
      queueMicrotask(() => acknowledge?.({ data: { kind: "event_ack", count: 1 } }))
      if (envelope.name !== "session_status_changed" || envelope.sessionId === undefined) return
      if (envelope.payload.status === "idle") idle.add(envelope.sessionId)
      else idle.delete(envelope.sessionId)
    },
    on: (event, listener) => {
      if (event === "message") acknowledge = listener as (event: { data: unknown }) => void
    },
    start: () => {},
    close: () => {},
  })
  const runtime = await createPiRuntime({ diagnostics: new Diagnostics(), emitter })

  const root = mkdtempSync(join(tmpdir(), "bakepi-budget-"))
  temporary.push(root)
  const { workspace } = await runtime.services.open_workspace({ root, runtime: { kind: "windows" } })
  await runtime.services.set_project_trust({ id: workspace.id, trust: "trusted" })

  const baseline = resident()

  /** One session, prompted once, so it carries a real history and a real file. */
  const openPrompted = async (): Promise<string> => {
    const { snapshot } = await runtime.services.create_session({ workspaceId: workspace.id })
    await turnOn(snapshot.summary.id)
    return snapshot.summary.id
  }

  /**
   * One turn, awaited to completion.
   *
   * `prompt` returns as soon as Pi accepts the run — the turn itself happens on
   * the event stream — so sampling straight after it would sample a turn in
   * flight and attribute half a response to the session that follows.
   */
  const turnOn = async (sessionId: string, text: string = "a measured reply"): Promise<void> => {
    server.script({ text: [text] })
    idle.delete(sessionId)
    await runtime.services.prompt({ sessionId, text: "measure me", attachments: [] })
    const deadline = Date.now() + 30_000
    while (!idle.has(sessionId)) {
      if (Date.now() > deadline) throw new Error(`session ${sessionId} never went idle`)
      await Bun.sleep(5)
    }
  }

  const first = await openPrompted()
  const afterFirst = resident()

  const samples: number[] = []
  let previous = afterFirst
  for (let index = 0; index < MEASURED_SESSIONS; index += 1) {
    await openPrompted()
    const now = resident()
    samples.push(now - previous)
    previous = now
  }
  const sessionSpread = spreadOf(samples)
  const perSession = sessionSpread.mean

  const turnSamples: number[] = []
  previous = resident()
  for (let index = 0; index < MEASURED_TURNS; index += 1) {
    await turnOn(first, TURN_TEXT)
    const now = resident()
    turnSamples.push(now - previous)
    previous = now
  }
  const half = Math.floor(turnSamples.length / 2)
  const earlySpread = spreadOf(turnSamples.slice(0, half))
  const lateSpread = spreadOf(turnSamples.slice(half))
  const lateTurns = lateSpread.mean
  const deepSession = turnSamples.reduce((total, sample) => total + sample, 0)

  const kb = String(TURN_TEXT_BYTES / 1024)
  console.log("host baseline (runtime, workspace, no session)  ", megabytes(baseline))
  console.log("first session (pays Pi's one-time lazy loading) ", megabytes(afterFirst - baseline))
  console.log(
    `marginal session (mean of ${String(MEASURED_SESSIONS)})              `,
    withPrecision(sessionSpread, MEASURED_SESSIONS),
  )
  console.log(`turn of ${kb} KB, mean over the first ${String(half)}          `, withPrecision(earlySpread, half))
  console.log(
    `turn of ${kb} KB, mean over the next ${String(turnSamples.length - half)}           `,
    withPrecision(lateSpread, turnSamples.length - half),
  )
  console.log(`one session, ${String(MEASURED_TURNS)} turns of ${kb} KB           `, megabytes(deepSession))
  console.log("session budget                                 ", megabytes(SESSION_MEMORY_BUDGET_BYTES))
  console.log("memory ceiling                                 ", megabytes(HOST_MEMORY_CEILING_BYTES))
  console.log("cap enforced                                   ", MAX_OPEN_SESSIONS)

  await runtime.services.shutdown({})
  await server.close()

  const failures: string[] = []
  if (baseline > HOST_BASELINE_CEILING_BYTES) {
    failures.push(`host baseline ${megabytes(baseline)} exceeds the declared ${megabytes(HOST_BASELINE_CEILING_BYTES)}`)
  }
  if (perSession > MEASURED_SESSION_BYTES) {
    failures.push(`a session costs ${megabytes(perSession)}, above the declared ${megabytes(MEASURED_SESSION_BYTES)}`)
  }
  // The late mean rather than the mean of all of them, because the late one is
  // the claim `MEASURED_TURN_BYTES` makes: what a turn costs on a session that
  // already has a history to resend.
  if (lateTurns > MEASURED_TURN_BYTES) {
    failures.push(`a deep turn costs ${megabytes(lateTurns)}, above the declared ${megabytes(MEASURED_TURN_BYTES)}`)
  }
  if (deepSession > MEASURED_DEEP_SESSION_BYTES) {
    const declared = megabytes(MEASURED_DEEP_SESSION_BYTES)
    failures.push(`a deep session costs ${megabytes(deepSession)}, above the declared ${declared}`)
  }
  // The cap has to be one the measurement supports. A cap above it promises more
  // sessions than the budget holds even before any of them has a history.
  if (MAX_OPEN_SESSIONS * perSession > SESSION_MEMORY_BUDGET_BYTES) {
    failures.push(`${String(MAX_OPEN_SESSIONS)} sessions at the measured cost do not fit the session budget`)
  }
  // The ceiling must leave room for the host it is measured on to open its first
  // session, or the limit refuses everything on a machine that is behaving.
  if (afterFirst >= HOST_MEMORY_CEILING_BYTES) {
    failures.push(`the ceiling ${megabytes(HOST_MEMORY_CEILING_BYTES)} is below one session on an idle host`)
  }

  for (const failure of failures) console.error(`budgets: ${failure}`)
  if (failures.length > 0) process.exitCode = 1
  else console.log("budgets ok")
}

try {
  await main()
} finally {
  for (const path of temporary) rmSync(path, { recursive: true, force: true })
}
