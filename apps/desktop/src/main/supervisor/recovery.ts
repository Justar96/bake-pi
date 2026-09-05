import type { CommandName } from "@bake-pi/contract"
import type { Clock } from "../observability/startup.ts"

/**
 * What the supervisor knows about the host it is supervising, and what it does
 * with that when the host dies.
 *
 * Main is the only party that survives a host crash, so it is the only party
 * that can decide what happens next. What it has to decide from is narrow, and
 * the narrowness is deliberate: main routes commands and never sees the event
 * stream, because a supervisor that read every streamed token would be the
 * bottleneck the direct `MessagePort` exists to avoid. So this ledger is built
 * entirely from commands going out and responses coming back.
 *
 * That is enough for the question the milestone asks — which session, if any,
 * was the host doing something for when it died — and for rebuilding the
 * workspace map a replacement host necessarily starts without. It remains
 * honest about the question it cannot answer. See `ambiguity` below.
 *
 * The same record answers a second question, and it does so for free. A command
 * that goes out and comes back is a duration, and the ledger is already standing
 * at both ends of it, so this is the one place in main that can say how long a
 * command took without a second bookkeeping structure shadowing the first. See
 * `commandLatency` for what that duration does and does not decompose into.
 */

/** A command main sent and has not yet had an answer to. */
interface InFlight {
  name: CommandName
  sessionId: string | undefined
  workspaceId: string | undefined
  /**
   * Main's own clock at the moment the command was handed to the host.
   *
   * Kept as an instant rather than a duration because the other end of the
   * measurement has not happened yet, and it is only ever subtracted from
   * another reading of the same clock in the same process. Nothing here is
   * comparable to the host's clock and nothing tries to be.
   */
  sentAt: number
  /**
   * Arrival in main to hand-off, when the router marked the arrival.
   *
   * `undefined` rather than zero where it was not marked: a command recorded
   * straight against the ledger — a test, or a future caller that is not the
   * router — has no arrival, and reporting that as a zero-millisecond main leg
   * would be inventing a measurement rather than admitting to missing one.
   */
  mainMs: number | undefined
}

/**
 * Commands whose interruption leaves state that cannot be described.
 *
 * A credential write is the case main can actually see: Pi's credential store
 * may or may not have been updated, and the difference matters enough that
 * guessing is worse than stopping. Retrying it silently could overwrite a key
 * that was already written, and reporting failure could claim a key was not
 * stored when it was.
 */
const AMBIGUOUS_COMMANDS = new Set<CommandName>(["set_api_key", "login", "logout"])

export type RestartMode = "automatic" | "confirm"

export interface RestartPlan {
  mode: RestartMode
  /** Sessions to reopen, in the order they were opened. */
  restore: string[]
  /** Sessions the crash was attributed to, which are deliberately not reopened. */
  quarantined: string[]
  /** Why the mode is `confirm`, for the diagnostics log and eventually the interface. */
  reason: "clean" | "ambiguous_mutation" | "budget_spent"
}

/**
 * One leg of a command's journey, summed rather than kept.
 *
 * Totals and maxima instead of samples, because the alternative is a list that
 * grows for as long as the application runs. A mean is `total / samples` and is
 * computed by whoever reads this; a maximum is the figure that actually matters
 * when someone says a command felt slow, and it survives being averaged away.
 */
export interface CommandLegSummary {
  /** Settled commands these round-trip figures are drawn from. */
  samples: number
  roundTripTotalMs: number
  roundTripMaxMs: number
  /**
   * Settles whose main leg was also measured, which may be fewer than
   * `samples`. Zero here means the two main figures below are unmeasured, not
   * that main took no time.
   */
  mainSamples: number
  mainTotalMs: number
  mainMaxMs: number
}

/**
 * How long one command name has been taking, split into the parts main can
 * actually see.
 *
 * Answered and failed are kept apart rather than summed. A command that failed
 * after the host spent thirty seconds on it is a real duration, but it is not a
 * reading of how long that command takes when it works, and averaging the two
 * together produces a number that describes neither.
 */
export interface CommandLatency {
  command: CommandName
  answered: CommandLegSummary
  failed: CommandLegSummary
}

const emptyLeg = (): CommandLegSummary => ({
  samples: 0,
  roundTripTotalMs: 0,
  roundTripMaxMs: 0,
  mainSamples: 0,
  mainTotalMs: 0,
  mainMaxMs: 0,
})

/** Sub-microsecond digits are noise from `performance.now()`, so they are dropped on the way out. */
const round = (value: number): number => Math.round(value * 1000) / 1000

const rounded = (leg: CommandLegSummary): CommandLegSummary => ({
  samples: leg.samples,
  roundTripTotalMs: round(leg.roundTripTotalMs),
  roundTripMaxMs: round(leg.roundTripMaxMs),
  mainSamples: leg.mainSamples,
  mainTotalMs: round(leg.mainTotalMs),
  mainMaxMs: round(leg.mainMaxMs),
})

export class RecoveryLedger {
  /** Insertion-ordered, which is the order sessions are restored in. */
  readonly #open = new Set<string>()
  /** Canonical roots successfully opened in the host, retained across its crash. */
  readonly #workspaceRoots = new Set<string>()
  /** Host-local workspace ids, used to apply a later `close_workspace`. */
  readonly #workspaceRootById = new Map<string, string>()
  /** Workspace ownership learned from the authoritative snapshot returned on attach. */
  readonly #workspaceBySession = new Map<string, string>()
  /** Stable ownership that survives the host-local workspace id changing on restart. */
  readonly #workspaceRootBySession = new Map<string, string>()
  readonly #quarantined = new Set<string>()
  readonly #inFlight = new Map<string, InFlight>()
  readonly #clock: Clock

  /**
   * Per command name, and therefore bounded by the contract.
   *
   * The key is a `CommandName` that the guard has already validated, so this map
   * cannot hold an entry for anything the contract does not define. Every
   * host-sent command can add one entry; `restart_host` is answered by main and
   * never reaches `noteSent`. Each entry is two `CommandLegSummary` objects of
   * six numbers each, so the whole aggregate is a few kilobytes once object
   * overhead is counted. It reaches its maximum after the first settle of every
   * command and does not grow again, whether the session lasts a minute or a
   * week.
   *
   * That bound is the reason this is sums rather than a ring of recent samples.
   * A ring would answer richer questions — a percentile, a trend — and would
   * cost a fixed amount too, but the host is the side already building one
   * (`agent-host/src/observability/timings.ts`), and main duplicating it would
   * mean two structures to keep honest for one question main can only answer
   * coarsely anyway.
   */
  readonly #latency = new Map<CommandName, { answered: CommandLegSummary; failed: CommandLegSummary }>()

  /**
   * The clock is injected so tests can state exact durations rather than assert
   * that a number is greater than zero, which is the assertion that passes no
   * matter what the code does. Same pattern and same reason as `Stopwatch` in
   * `observability/startup.ts`.
   */
  constructor(clock: Clock = () => performance.now()) {
    this.#clock = clock
  }

  get openSessions(): string[] {
    return [...this.#open]
  }

  get openWorkspaceRoots(): string[] {
    return [...this.#workspaceRoots]
  }

  get quarantinedSessions(): string[] {
    return [...this.#quarantined]
  }

  /** A deliberate runtime switch stops the old host and leaves none of its host-local state open. */
  resetRuntime(): void {
    this.#open.clear()
    this.#workspaceRoots.clear()
    this.#workspaceRootById.clear()
    this.#workspaceBySession.clear()
    this.#workspaceRootBySession.clear()
    this.#quarantined.clear()
    this.#inFlight.clear()
  }

  /**
   * Stops retrying a session whose supervisor-issued restore was rejected.
   *
   * The host that used to own it is already gone, so a failed adoption means it
   * is not open in the replacement either. Keeping it here would turn every
   * later, unrelated crash into another automatic adoption attempt. A crash
   * during the attempt is different: `planRestart` has already quarantined the
   * session, and this method deliberately leaves that evidence intact.
   */
  noteRestoreFailed(sessionId: string): void {
    this.#open.delete(sessionId)
    this.#workspaceBySession.delete(sessionId)
    this.#workspaceRootBySession.delete(sessionId)
  }

  /** Stops retrying a workspace root the replacement host could not reopen. */
  noteWorkspaceRestoreFailed(root: string): void {
    this.#workspaceRoots.delete(root)
    for (const [id, recordedRoot] of this.#workspaceRootById) {
      if (recordedRoot === root) this.#workspaceRootById.delete(id)
    }
  }

  /**
   * Where a command's time went, as far as main can honestly say — sorted by
   * command name so two readings can be diffed.
   *
   * Two legs, both timed end to end inside main with main's own clock:
   *
   * - `main` is arrival in the command handler to the command leaving for the
   *   host. It is main's whole contribution as main can observe it: envelope and
   *   sender validation in `ipc/guard.ts`, the main-owned check, and the
   *   dispatch itself.
   * - `roundTrip` is the command leaving for the host to its answer being in
   *   hand. It contains the `MessagePort` hop each way, whatever queueing the
   *   host does, and the host's handler.
   *
   * What is deliberately absent is a decomposition of that round trip, because
   * main cannot measure one. Splitting it would need either an instant taken in
   * the host and subtracted from an instant taken here — a cross-process
   * timestamp, which nothing in this codebase does and `scripts/clocks.ts`
   * records the reasons for — or a claim about transport cost that nobody has
   * measured. The host times its own handler and reports it as a duration, and
   * subtracting two durations is sound where subtracting two clocks is not;
   * `readStartupTimings` already does exactly that to recover the fork leg from
   * the handshake. Round trip minus the host's own figure is the transport and
   * queueing leg, and it is a subtraction whoever holds both numbers can do.
   *
   * Also absent, and unfixable from here: the renderer-to-main hop. A command
   * exists in the renderer before main sees it, and the only way to price that
   * leg is a renderer timestamp compared against main's — the exact thing that
   * is not allowed. Main's leg starts when main starts.
   */
  get commandLatency(): CommandLatency[] {
    return [...this.#latency.entries()]
      .map(([command, legs]) => ({ command, answered: rounded(legs.answered), failed: rounded(legs.failed) }))
      .sort((left, right) => left.command.localeCompare(right.command))
  }

  /**
   * Records a command on its way to the host. The id is main's own request id.
   *
   * Arrival is a value carried by this command, not a shared slot on the
   * ledger. That keeps concurrent dispatches independent even if validation or
   * a future main-owned preflight yields before the host hand-off.
   */
  noteSent(id: string, name: CommandName, params: unknown, timing: { arrivedAt?: number } = {}): void {
    const sentAt = this.#clock()
    this.#inFlight.set(id, {
      name,
      sessionId: sessionIdOf(params),
      workspaceId: name === "close_workspace" ? idOf(params) : undefined,
      sentAt,
      mainMs: timing.arrivedAt === undefined ? undefined : sentAt - timing.arrivedAt,
    })
  }

  /**
   * Records the answer, and what it says about which sessions exist.
   *
   * A session becomes open when the host answers with its snapshot, not when the
   * command is sent: a `create_session` that failed opened nothing, and
   * restoring it after a crash would ask the host to reopen a session that was
   * never there.
   */
  noteSettled(id: string, outcome: { ok: boolean; result?: unknown }): void {
    const sent = this.#inFlight.get(id)
    this.#inFlight.delete(id)
    if (sent !== undefined) this.#recordLatency(sent, outcome.ok, this.#clock() - sent.sentAt)
    if (sent === undefined || !outcome.ok) return

    if (sent.name === "open_workspace") {
      const workspace = workspaceOf(outcome.result)
      if (workspace === undefined) return
      this.#workspaceRoots.add(workspace.root)
      this.#workspaceRootById.set(workspace.id, workspace.root)
      return
    }

    if (sent.name === "close_session") {
      if (sent.sessionId !== undefined) {
        this.#open.delete(sent.sessionId)
        this.#workspaceBySession.delete(sent.sessionId)
        this.#workspaceRootBySession.delete(sent.sessionId)
      }
      return
    }

    if (sent.name === "close_workspace") {
      if (sent.workspaceId === undefined) return
      const root = this.#workspaceRootById.get(sent.workspaceId)
      this.#workspaceRootById.delete(sent.workspaceId)
      if (root !== undefined && ![...this.#workspaceRootById.values()].includes(root)) {
        this.#workspaceRoots.delete(root)
      }
      for (const [sessionId, workspaceId] of this.#workspaceBySession) {
        const belongsByRoot = root !== undefined && this.#workspaceRootBySession.get(sessionId) === root
        if (workspaceId !== sent.workspaceId && !belongsByRoot) continue
        this.#open.delete(sessionId)
        this.#quarantined.delete(sessionId)
        this.#workspaceBySession.delete(sessionId)
        this.#workspaceRootBySession.delete(sessionId)
      }
      return
    }

    const snapshot = (outcome.result as { snapshot?: unknown } | undefined)?.snapshot
    const opened = sessionIdOf(snapshot)
    if (opened === undefined) return
    // Reopening a quarantined session is how a person overrides the supervisor,
    // so a successful open clears the quarantine rather than being ignored.
    this.#quarantined.delete(opened)
    this.#open.add(opened)
    const workspaceId = workspaceIdOf(snapshot)
    if (workspaceId !== undefined) {
      this.#workspaceBySession.set(opened, workspaceId)
      const root = this.#workspaceRootById.get(workspaceId)
      if (root !== undefined) this.#workspaceRootBySession.set(opened, root)
    }
  }

  /** Folds one settled command into the summary for its name. */
  #recordLatency(sent: InFlight, ok: boolean, roundTripMs: number): void {
    let legs = this.#latency.get(sent.name)
    if (legs === undefined) {
      legs = { answered: emptyLeg(), failed: emptyLeg() }
      this.#latency.set(sent.name, legs)
    }
    const leg = ok ? legs.answered : legs.failed
    leg.samples += 1
    leg.roundTripTotalMs += roundTripMs
    if (roundTripMs > leg.roundTripMaxMs) leg.roundTripMaxMs = roundTripMs
    if (sent.mainMs === undefined) return
    leg.mainSamples += 1
    leg.mainTotalMs += sent.mainMs
    if (sent.mainMs > leg.mainMaxMs) leg.mainMaxMs = sent.mainMs
  }

  /**
   * Everything in flight is failed by the crash, so nothing stays pending across
   * one. Called when the host exits.
   *
   * These commands contribute nothing to `commandLatency`, and that is a
   * decision rather than an oversight. The router settles each of them a moment
   * later, finds no entry here, and records nothing — so the figure that would
   * have been kept, "how long until the process died", never enters an aggregate
   * that a reader will interpret as how long the command takes. The crash is
   * already recorded, in the form that is useful about a crash: the quarantine
   * below.
   */
  #takeInFlight(): InFlight[] {
    const pending = [...this.#inFlight.values()]
    this.#inFlight.clear()
    return pending
  }

  /**
   * What to do about a host that just exited.
   *
   * Attribution is by what the host was working on. A command in flight for a
   * session when the process died is the best evidence available that the
   * session is what killed it, and it is the evidence that matters: a session
   * that deterministically crashes the adapter would otherwise be reopened on
   * every restart and burn the entire budget, leaving no route to open a
   * different one. That is the failure this whole file exists to prevent.
   *
   * It is a heuristic and it can be wrong — a crash from an unrelated cause
   * during a prompt quarantines a session that did nothing. Being wrong this way
   * costs one session that a person can reopen by hand. Being wrong the other
   * way costs the application.
   */
  planRestart(options: { budgetRemains: boolean }): RestartPlan {
    const pending = this.#takeInFlight()
    // These ids belonged to the process that just exited. Roots and session
    // ownership survive; the replacement ids are learned as roots reopen.
    this.#workspaceRootById.clear()
    for (const command of pending) {
      if (command.sessionId !== undefined) this.#quarantined.add(command.sessionId)
    }
    for (const sessionId of this.#quarantined) this.#open.delete(sessionId)

    const ambiguous = pending.some((command) => AMBIGUOUS_COMMANDS.has(command.name))
    const restore = [...this.#open]
    const quarantined = [...this.#quarantined]

    // Order matters: an ambiguous mutation is reported as such even when the
    // budget is also spent, because it is the more specific thing to tell
    // someone and the one that changes what they should do next.
    if (ambiguous) return { mode: "confirm", restore, quarantined, reason: "ambiguous_mutation" }
    if (!options.budgetRemains) return { mode: "confirm", restore, quarantined, reason: "budget_spent" }
    return { mode: "automatic", restore, quarantined, reason: "clean" }
  }

  /**
   * What this ledger cannot see, and who covers it instead.
   *
   * A tool call is the other interruption that leaves the workspace in a state
   * nobody can describe — a half-written file, a command that ran once and may
   * run again — and main still cannot detect one. Tools start and finish as
   * events on the port main deliberately does not read, so from here a crash
   * during a tool call and a crash during an idle moment remain the same
   * observation. That has not changed and is not going to: teeing the event
   * stream into main to fix it would give up the property that keeps streaming
   * off the supervisor's hot path.
   *
   * What changed is that nothing here has to see it. The agent host writes a
   * marker beside the session file before each tool runs and removes it when the
   * call ends (`agent-host/src/session/tool-marker.ts`), so the evidence
   * survives exactly the crash that produced it. Every session this plan
   * restores comes back through `open_session`, which is the same adoption path
   * that reads the marker — so a restart reports its own interrupted tools
   * without the supervisor learning anything new.
   *
   * The one case the marker outlives a restart is a quarantined session, which
   * is deliberately not reopened. Its marker waits on disk until someone opens
   * that session by hand, which is the moment the warning is worth reading.
   */
  readonly ambiguity = "credential mutations only; tool execution is reported by the host on adoption"
}

/**
 * The aggregate as a person reads it, one line per command name and outcome.
 *
 * This exists because a number nobody can see answers nothing. `commandLatency`
 * is the structure, and the structure has no route to a developer yet: the
 * command that reports diagnostics to the renderer is answered by the agent
 * host, not by main, so main's own figures cannot ride along on it without a
 * contract change. Until one of those exists, a line in the diagnostics log is
 * the surface, and this is the function that produces it from one caller.
 *
 * Means are computed here rather than stored, because a mean is what a reader
 * wants and a sum is what can be accumulated without keeping samples. Where the
 * main leg was measured for only some of the settles, the line says so instead
 * of dividing by the wrong denominator.
 */
export const formatCommandLatency = (rows: readonly CommandLatency[]): string => {
  const lines: string[] = []
  for (const row of rows) {
    for (const [outcome, leg] of [
      ["answered", row.answered],
      ["failed", row.failed],
    ] as const) {
      if (leg.samples === 0) continue
      const mean = round(leg.roundTripTotalMs / leg.samples)
      lines.push(
        `${row.command} ${outcome} ${String(leg.samples)}: round trip ${String(mean)}ms mean, ` +
          `${String(leg.roundTripMaxMs)}ms max; ${formatMainLeg(leg)}`,
      )
    }
  }
  return lines.length === 0 ? "no commands settled yet" : lines.join("\n")
}

const formatMainLeg = (leg: CommandLegSummary): string => {
  if (leg.mainSamples === 0) return "main leg unmeasured"
  const mean = round(leg.mainTotalMs / leg.mainSamples)
  const main = `main ${String(mean)}ms mean, ${String(leg.mainMaxMs)}ms max`
  return leg.mainSamples === leg.samples
    ? main
    : `${main} over ${String(leg.mainSamples)} of ${String(leg.samples)}`
}

/** Pulls a session id out of whatever shape the command or result carries one in. */
const sessionIdOf = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const direct = (value as { sessionId?: unknown }).sessionId
  if (typeof direct === "string") return direct
  // A snapshot names its session through its summary.
  const summary = (value as { summary?: { id?: unknown } }).summary
  return typeof summary?.id === "string" ? summary.id : undefined
}

/** Pulls workspace ownership out of the snapshot summary returned when a session attaches. */
const workspaceIdOf = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const summary = (value as { summary?: { workspaceId?: unknown } }).summary
  return typeof summary?.workspaceId === "string" ? summary.workspaceId : undefined
}

/** Pulls the host-local id and canonical root out of an `open_workspace` result. */
const workspaceOf = (value: unknown): { id: string; root: string } | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const workspace = (value as { workspace?: { id?: unknown; root?: unknown } }).workspace
  if (typeof workspace?.id !== "string" || typeof workspace.root !== "string") return undefined
  return { id: workspace.id, root: workspace.root }
}

/** `close_workspace` calls its workspace key `id`; keep that special case at the command boundary. */
const idOf = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const id = (value as { id?: unknown }).id
  return typeof id === "string" ? id : undefined
}
