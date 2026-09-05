import { describe, expect, test } from "bun:test"
import { COMMAND_NAMES, type CommandName, MAIN_OWNED_COMMANDS, isMainOwnedCommand } from "@bake-pi/contract"
import { RecoveryLedger, formatCommandLatency } from "./recovery.ts"
import { RestartBudget } from "./health.ts"

const windowsRuntime = { kind: "windows" as const }

/**
 * What the supervisor decides after a crash.
 *
 * The rule this file defends is the one in the register: one session must not be
 * able to exhaust recovery for all of them. A host that deterministically dies
 * on one session, reopened faithfully on every restart, spends the entire
 * restart budget on that session and leaves no route to open a different one —
 * so the application ends up unusable because of one file.
 *
 * The mechanism is narrow because main's knowledge is narrow. Main routes
 * commands and never reads the event stream, which is what keeps a streamed
 * token off the supervisor's hot path, so a command in flight when the process
 * died is the entire body of evidence. These tests are written against that
 * evidence rather than against a richer model of the world main does not have.
 */

const snapshotFor = (sessionId: string, workspaceId = "w1"): unknown => ({
  snapshot: { summary: { id: sessionId, workspaceId } },
})

/** Opens a session the way the router records one: a command out, a snapshot back. */
const open = (ledger: RecoveryLedger, sessionId: string, id = `open-${sessionId}`, workspaceId = "w1"): void => {
  ledger.noteSent(id, "open_session", { sessionId })
  ledger.noteSettled(id, { ok: true, result: snapshotFor(sessionId, workspaceId) })
}

describe("what the supervisor knows about the host", () => {
  test("remembers only workspaces the host opened, and forgets one after close", () => {
    const ledger = new RecoveryLedger()
    ledger.noteSent("open-w1", "open_workspace", { root: "C:\\work", runtime: windowsRuntime })
    expect(ledger.openWorkspaceRoots).toEqual([])

    ledger.noteSettled("open-w1", {
      ok: true,
      result: { workspace: { id: "w1", root: "C:\\work", runtime: windowsRuntime } },
    })
    expect(ledger.openWorkspaceRoots).toEqual(["C:\\work"])

    ledger.noteSent("close-w1", "close_workspace", { id: "w1" })
    ledger.noteSettled("close-w1", { ok: true, result: {} })
    expect(ledger.openWorkspaceRoots).toEqual([])
  })

  test("a session is open once the host answers, not when the command is sent", () => {
    const ledger = new RecoveryLedger()
    ledger.noteSent("c1", "create_session", { workspaceId: "w1" })
    expect(ledger.openSessions).toEqual([])

    ledger.noteSettled("c1", { ok: true, result: snapshotFor("s1") })
    expect(ledger.openSessions).toEqual(["s1"])
  })

  test("a session that failed to open is not remembered as open", () => {
    const ledger = new RecoveryLedger()
    ledger.noteSent("c1", "create_session", { workspaceId: "w1" })
    // A result alongside the failure, which is the case worth pinning: the
    // outcome decides, not the payload. A partial response from a host that then
    // died would otherwise be read as a session that exists, and restoring it
    // would ask the next host to reopen something that was never there.
    ledger.noteSettled("c1", { ok: false, result: snapshotFor("s1") })
    expect(ledger.openSessions).toEqual([])
  })

  test("closing a session removes it, so a crash later does not resurrect it", () => {
    const ledger = new RecoveryLedger()
    open(ledger, "s1")
    open(ledger, "s2")

    ledger.noteSent("x", "close_session", { sessionId: "s1" })
    ledger.noteSettled("x", { ok: true, result: {} })

    expect(ledger.openSessions).toEqual(["s2"])
  })

  test("closing a workspace removes only its sessions, so a crash does not resurrect them", () => {
    const ledger = new RecoveryLedger()
    open(ledger, "s1", "open-s1", "w1")
    open(ledger, "s2", "open-s2", "w1")
    open(ledger, "s3", "open-s3", "w2")

    ledger.noteSent("close-w1", "close_workspace", { id: "w1" })
    ledger.noteSettled("close-w1", { ok: true, result: {} })

    expect(ledger.openSessions).toEqual(["s3"])
    expect(ledger.planRestart({ budgetRemains: true }).restore).toEqual(["s3"])
  })

  test("a failed workspace close leaves its sessions recoverable", () => {
    const ledger = new RecoveryLedger()
    open(ledger, "s1", "open-s1", "w1")

    ledger.noteSent("close-w1", "close_workspace", { id: "w1" })
    ledger.noteSettled("close-w1", { ok: false })

    expect(ledger.openSessions).toEqual(["s1"])
  })

  test("a replacement workspace id still owns quarantines from the dead host", () => {
    const ledger = new RecoveryLedger()
    ledger.noteSent("open-old", "open_workspace", { root: "C:\\work", runtime: windowsRuntime })
    ledger.noteSettled("open-old", {
      ok: true,
      result: { workspace: { id: "old-workspace", root: "C:\\work", runtime: windowsRuntime } },
    })
    open(ledger, "poison", "open-poison", "old-workspace")
    ledger.noteSent("prompt", "prompt", { sessionId: "poison", text: "crash" })
    ledger.planRestart({ budgetRemains: true })

    ledger.noteSent("open-new", "open_workspace", { root: "C:\\work", runtime: windowsRuntime })
    ledger.noteSettled("open-new", {
      ok: true,
      result: { workspace: { id: "new-workspace", root: "C:\\work", runtime: windowsRuntime } },
    })
    ledger.noteSent("close-new", "close_workspace", { id: "new-workspace" })
    ledger.noteSettled("close-new", { ok: true, result: {} })

    expect(ledger.quarantinedSessions).toEqual([])
    expect(ledger.openWorkspaceRoots).toEqual([])
  })
})

describe("attributing a crash", () => {
  test("the session the host was working on is quarantined and not restored", () => {
    const ledger = new RecoveryLedger()
    open(ledger, "safe")
    open(ledger, "poison")

    // A prompt for `poison` is outstanding when the process dies.
    ledger.noteSent("p", "prompt", { sessionId: "poison", text: "hello" })
    const plan = ledger.planRestart({ budgetRemains: true })

    expect(plan.quarantined).toEqual(["poison"])
    expect(plan.restore).toEqual(["safe"])
    expect(plan.mode).toBe("automatic")
  })

  test("a crash with nothing in flight blames no session and restores everything", () => {
    const ledger = new RecoveryLedger()
    open(ledger, "s1")
    open(ledger, "s2")

    const plan = ledger.planRestart({ budgetRemains: true })

    expect(plan.quarantined).toEqual([])
    expect(plan.restore).toEqual(["s1", "s2"])
    expect(plan.reason).toBe("clean")
  })

  test("a quarantine holds across later crashes rather than being re-decided", () => {
    const ledger = new RecoveryLedger()
    open(ledger, "safe")
    open(ledger, "poison")

    ledger.noteSent("p", "prompt", { sessionId: "poison", text: "hello" })
    ledger.planRestart({ budgetRemains: true })
    // A second, unrelated crash. `poison` was never reopened, so nothing about
    // it is in flight — and it must still not come back.
    const second = ledger.planRestart({ budgetRemains: true })

    expect(second.restore).toEqual(["safe"])
    expect(second.quarantined).toEqual(["poison"])
  })

  test("reopening a quarantined session by hand lifts the quarantine", () => {
    const ledger = new RecoveryLedger()
    open(ledger, "poison")
    ledger.noteSent("p", "prompt", { sessionId: "poison", text: "hello" })
    ledger.planRestart({ budgetRemains: true })

    // The supervisor's judgement is a default, not a verdict. Someone who
    // opens it anyway has overruled it, and the next crash judges it afresh.
    open(ledger, "poison", "reopen")

    expect(ledger.quarantinedSessions).toEqual([])
    expect(ledger.openSessions).toEqual(["poison"])
  })

  test("nothing stays pending across a crash, so the next one is judged on its own", () => {
    const ledger = new RecoveryLedger()
    open(ledger, "s1")
    ledger.noteSent("p", "prompt", { sessionId: "s1", text: "hello" })
    ledger.planRestart({ budgetRemains: true })
    open(ledger, "s2")

    const second = ledger.planRestart({ budgetRemains: true })

    // `s1` is still quarantined from the first crash, but it is not blamed
    // again — a stale in-flight record would quarantine a session on every
    // subsequent crash forever.
    expect(second.quarantined).toEqual(["s1"])
    expect(second.restore).toEqual(["s2"])
  })

  test("one poisonous session cannot spend the budget the others need", () => {
    // The whole point, driven end to end against the real budget.
    const ledger = new RecoveryLedger()
    const budget = new RestartBudget({ maxRestarts: 3, windowMs: 60_000 })
    open(ledger, "safe")
    open(ledger, "poison")

    // The host dies while working on `poison`.
    ledger.noteSent("p", "prompt", { sessionId: "poison", text: "hello" })
    const plan = ledger.planRestart({ budgetRemains: budget.record() })

    expect(plan.mode).toBe("automatic")
    expect(plan.quarantined).toEqual(["poison"])
    // The restart brings back everything except the session that was implicated,
    // which is the difference between recovering and looping.
    expect(plan.restore).toEqual(["safe"])
    expect(budget.recentFailures).toBe(1)

    // The counterfactual, spelled out: restoring it faithfully means the same
    // prompt is in flight on the next crash, and on the one after that. Three
    // more crashes and the budget is gone with no route left to open anything.
    const faithful = new RecoveryLedger()
    const spent = new RestartBudget({ maxRestarts: 3, windowMs: 60_000 })
    let looping = { mode: "automatic", reason: "clean" } as { mode: string; reason: string }
    for (let index = 0; index < 4; index += 1) {
      open(faithful, "poison", `reopen-${String(index)}`)
      faithful.noteSent(`p${String(index)}`, "prompt", { sessionId: "poison", text: "hello" })
      looping = faithful.planRestart({ budgetRemains: spent.record() })
    }
    expect(looping.mode).toBe("confirm")
    expect(looping.reason).toBe("budget_spent")
  })
})

describe("an interruption nobody can describe", () => {
  test("a crash during a credential write is not restarted automatically", () => {
    const ledger = new RecoveryLedger()
    open(ledger, "s1")
    ledger.noteSent("k", "set_api_key", { providerId: "anthropic", apiKey: "secret" })

    const plan = ledger.planRestart({ budgetRemains: true })

    // Pi's credential store may or may not have been written. Retrying could
    // overwrite a key that landed; reporting failure could deny one that did.
    expect(plan.mode).toBe("confirm")
    expect(plan.reason).toBe("ambiguous_mutation")
  })

  test("login and logout are ambiguous the same way", () => {
    for (const name of ["login", "logout"] as const) {
      const ledger = new RecoveryLedger()
      ledger.noteSent("c", name, { providerId: "anthropic" })
      expect(ledger.planRestart({ budgetRemains: true }).reason).toBe("ambiguous_mutation")
    }
  })

  test("an ambiguous mutation is reported ahead of a spent budget", () => {
    const ledger = new RecoveryLedger()
    ledger.noteSent("k", "set_api_key", { providerId: "anthropic", apiKey: "secret" })

    // Both are true. The mutation is the more specific thing to say and the one
    // that changes what a person should check before continuing.
    expect(ledger.planRestart({ budgetRemains: false }).reason).toBe("ambiguous_mutation")
  })

  test("an ordinary session command is not treated as ambiguous", () => {
    const ledger = new RecoveryLedger()
    open(ledger, "s1")
    ledger.noteSent("p", "prompt", { sessionId: "s1", text: "hello" })

    // A prompt interrupted mid-turn is recoverable: Pi's session file is
    // append-only and the turn either landed or did not. It quarantines the
    // session without stopping the restart.
    const plan = ledger.planRestart({ budgetRemains: true })
    expect(plan.mode).toBe("automatic")
    expect(plan.quarantined).toEqual(["s1"])
  })
})

/**
 * Where a command's time went.
 *
 * The ledger already stands at both ends of every command, so it is the only
 * place in main that can time one without a second structure shadowing the
 * first. What it can time is bounded by what main can see, and these tests are
 * written to that boundary rather than past it: main's leg is arrival in the
 * router to hand-off, the round trip is hand-off to answer, and the split of the
 * round trip into transport and host handler is not main's to make. Every
 * reading below is one clock in one process.
 *
 * The clock is injected for a specific reason. A timing test written against a
 * real clock can only assert that a duration is greater than zero, and that
 * assertion holds whether the code measures the right leg, the wrong leg, or the
 * same leg twice. Scripted instants let each test state the exact number it
 * expects, so swapping the two legs or dropping one of them fails here.
 */

/** A clock the test steps by hand, so every duration below is stated rather than observed. */
const testClock = (): { read: () => number; set: (ms: number) => void } => {
  let now = 0
  return {
    read: () => now,
    set: (ms: number) => {
      now = ms
    },
  }
}

interface CommandRun {
  id: string
  name: CommandName
  params?: unknown
  /** Main's clock when the router received it. */
  arrivedAt: number
  /** Main's clock when it left for the host, after validation and dispatch. */
  sentAt: number
  /** Main's clock when the answer was in hand. */
  settledAt: number
  ok: boolean
  result?: unknown
}

/**
 * Drives one command through the ledger in the order the router does it.
 *
 * Arrival travels as a value on the command. The router may therefore validate
 * concurrent commands without one timing mark overwriting another.
 */
const runCommand = (ledger: RecoveryLedger, clock: { set: (ms: number) => void }, run: CommandRun): void => {
  clock.set(run.arrivedAt)
  clock.set(run.sentAt)
  ledger.noteSent(run.id, run.name, run.params, { arrivedAt: run.arrivedAt })
  clock.set(run.settledAt)
  ledger.noteSettled(run.id, { ok: run.ok, result: run.result })
}

const noLegs = { samples: 0, roundTripTotalMs: 0, roundTripMaxMs: 0, mainSamples: 0, mainTotalMs: 0, mainMaxMs: 0 }

describe("where a command's time went", () => {
  test("main's own leg and the host round trip are recorded as separate numbers", () => {
    const clock = testClock()
    const ledger = new RecoveryLedger(clock.read)

    runCommand(ledger, clock, {
      id: "p",
      name: "prompt",
      params: { sessionId: "s1" },
      arrivedAt: 100,
      sentAt: 103,
      settledAt: 143,
      ok: true,
      result: snapshotFor("s1"),
    })

    // Three milliseconds validating and dispatching, forty waiting for the host.
    // Stated as two numbers rather than one total and a residual, which is the
    // whole point: a residual would stand in for both of these at once.
    expect(ledger.commandLatency).toEqual([
      {
        command: "prompt",
        answered: {
          samples: 1,
          roundTripTotalMs: 40,
          roundTripMaxMs: 40,
          mainSamples: 1,
          mainTotalMs: 3,
          mainMaxMs: 3,
        },
        failed: noLegs,
      },
    ])
  })

  test("a command that failed is timed too, and kept apart from the ones that worked", () => {
    const clock = testClock()
    const ledger = new RecoveryLedger(clock.read)

    runCommand(ledger, clock, { id: "a", name: "open_session", arrivedAt: 0, sentAt: 1, settledAt: 11, ok: true })
    runCommand(ledger, clock, { id: "b", name: "open_session", arrivedAt: 20, sentAt: 22, settledAt: 122, ok: false })

    // A failure is a real duration and it is worth having — but folding it in
    // with the successes would make a hundred-millisecond rejection look like
    // evidence that opening a session is slow, which is a different claim.
    const [row] = ledger.commandLatency
    expect(row).toEqual({
      command: "open_session",
      answered: { samples: 1, roundTripTotalMs: 10, roundTripMaxMs: 10, mainSamples: 1, mainTotalMs: 1, mainMaxMs: 1 },
      failed: { samples: 1, roundTripTotalMs: 100, roundTripMaxMs: 100, mainSamples: 1, mainTotalMs: 2, mainMaxMs: 2 },
    })
  })

  test("the maximum is the slowest command seen, not the most recent one", () => {
    const clock = testClock()
    const ledger = new RecoveryLedger(clock.read)

    runCommand(ledger, clock, { id: "1", name: "prompt", arrivedAt: 0, sentAt: 3, settledAt: 13, ok: true })
    runCommand(ledger, clock, { id: "2", name: "prompt", arrivedAt: 20, sentAt: 29, settledAt: 79, ok: true })
    runCommand(ledger, clock, { id: "3", name: "prompt", arrivedAt: 90, sentAt: 94, settledAt: 114, ok: true })

    // The slow one is in the middle on both legs deliberately, and the two legs
    // peak on the same command only by construction. A maximum that tracked the
    // last sample, or the first, would report a healthy command either way — and
    // it has to be wrong for main's leg as well as the round trip, because a
    // maximum kept correctly on one and carelessly on the other is exactly how
    // an instrument ends up trusted for the wrong half of its output.
    const [row] = ledger.commandLatency
    expect(row?.answered.samples).toBe(3)
    expect(row?.answered.roundTripTotalMs).toBe(80)
    expect(row?.answered.roundTripMaxMs).toBe(50)
    expect(row?.answered.mainTotalMs).toBe(16)
    expect(row?.answered.mainMaxMs).toBe(9)
  })

  test("a command recorded without an arrival reports main's leg missing rather than instant", () => {
    const clock = testClock()
    const ledger = new RecoveryLedger(clock.read)

    // Straight to the ledger, with no router frame around it and so no arrival
    // to measure — the shape any future caller that is not the router has.
    clock.set(0)
    ledger.noteSent("bare", "list_models", {})
    clock.set(5)
    ledger.noteSettled("bare", { ok: true })
    runCommand(ledger, clock, { id: "routed", name: "list_models", arrivedAt: 10, sentAt: 14, settledAt: 20, ok: true })

    // Two round trips, one main leg. `mainTotalMs` is the sum over the one that
    // had a main leg, and `mainSamples` is what stops a reader dividing it by
    // two — a defaulted zero would halve the figure and look like an
    // improvement.
    const [row] = ledger.commandLatency
    expect(row?.answered.samples).toBe(2)
    expect(row?.answered.mainSamples).toBe(1)
    expect(row?.answered.mainTotalMs).toBe(4)
    expect(row?.answered.mainMaxMs).toBe(4)
    expect(row?.answered.roundTripTotalMs).toBe(11)
  })

  test("each arrival value belongs to its command", () => {
    const clock = testClock()
    const ledger = new RecoveryLedger(clock.read)

    clock.set(0)
    clock.set(2)
    ledger.noteSent("first", "prompt", {}, { arrivedAt: 0 })
    clock.set(7)
    ledger.noteSent("second", "prompt", {}, { arrivedAt: 3 })
    clock.set(10)
    ledger.noteSettled("first", { ok: true })
    ledger.noteSettled("second", { ok: true })

    const [row] = ledger.commandLatency
    expect(row?.answered.samples).toBe(2)
    expect(row?.answered.mainSamples).toBe(2)
    expect(row?.answered.mainTotalMs).toBe(6)
    expect(row?.answered.mainMaxMs).toBe(4)
  })

  test("a command without an arrival value cannot inherit an earlier one", () => {
    const clock = testClock()
    const ledger = new RecoveryLedger(clock.read)

    clock.set(1000)
    ledger.noteSent("late", "prompt", {})
    clock.set(1005)
    ledger.noteSettled("late", { ok: true })

    const [row] = ledger.commandLatency
    expect(row?.answered.mainSamples).toBe(0)
    expect(row?.answered.roundTripTotalMs).toBe(5)
  })

  test("a command the crash took with it is not a latency sample", () => {
    const clock = testClock()
    const ledger = new RecoveryLedger(clock.read)
    open(ledger, "s1")

    clock.set(0)
    ledger.noteSent("p", "prompt", { sessionId: "s1" })
    clock.set(30_000)
    ledger.planRestart({ budgetRemains: true })
    // The router settles it a moment later, after the exit handler has already
    // read the ledger. "Thirty seconds until the process died" is not how long a
    // prompt takes, and an aggregate that carried it would say it was.
    clock.set(30_001)
    ledger.noteSettled("p", { ok: false })

    // The `open_session` that settled normally is still there; the prompt the
    // crash swallowed is not, and that is the distinction being asserted.
    expect(ledger.commandLatency.map((row) => row.command)).toEqual(["open_session"])
    // Crash attribution is what that record was for, and it still holds.
    expect(ledger.quarantinedSessions).toEqual(["s1"])
  })

  test("the aggregate is bounded by the contract, not by how long the session runs", () => {
    const clock = testClock()
    const ledger = new RecoveryLedger(clock.read)
    // `restart_host` is answered by main and never sent, so it never reaches the
    // ledger; every other command name can.
    const sendable = COMMAND_NAMES.filter((name) => !isMainOwnedCommand(name))
    // Derived rather than a literal. The point under test is that the aggregate
    // is bounded by the size of the contract, and a hard-coded count asserts
    // instead that the contract has a particular size — which turns every new
    // command into a failure here, in a file about crash recovery, for a reason
    // that has nothing to do with either.
    expect(sendable.length).toBe(COMMAND_NAMES.length - MAIN_OWNED_COMMANDS.length)
    expect(sendable.length).toBeGreaterThan(0)

    let at = 0
    const sweep = (): void => {
      for (const name of sendable) {
        for (let index = 0; index < 25; index += 1) {
          at += 10
          runCommand(ledger, clock, {
            id: `${name}-${String(at)}`,
            name,
            arrivedAt: at,
            sentAt: at,
            settledAt: at + 1,
            ok: true,
          })
        }
      }
    }

    sweep()
    const first = ledger.commandLatency
    sweep()
    const second = ledger.commandLatency

    // One entry per command name after a thousand commands, and the same one
    // entry per name after two thousand. The samples counter is what grows; the
    // structure holding it does not.
    expect(first.length).toBe(sendable.length)
    expect(second.length).toBe(sendable.length)
    expect(second.length).toBeLessThanOrEqual(COMMAND_NAMES.length)
    expect(first[0]?.answered.samples).toBe(25)
    expect(second[0]?.answered.samples).toBe(50)
    expect(second[0]?.answered.roundTripMaxMs).toBe(1)
  })

  test("commands are reported in name order, so two readings can be diffed", () => {
    const clock = testClock()
    const ledger = new RecoveryLedger(clock.read)

    runCommand(ledger, clock, { id: "1", name: "prompt", arrivedAt: 0, sentAt: 0, settledAt: 1, ok: true })
    runCommand(ledger, clock, { id: "2", name: "abort", arrivedAt: 2, sentAt: 2, settledAt: 3, ok: true })
    runCommand(ledger, clock, { id: "3", name: "list_models", arrivedAt: 4, sentAt: 4, settledAt: 5, ok: true })

    expect(ledger.commandLatency.map((row) => row.command)).toEqual(["abort", "list_models", "prompt"])
  })
})

describe("reading the aggregate", () => {
  test("each command and outcome is one line, with the mean computed at read time", () => {
    const clock = testClock()
    const ledger = new RecoveryLedger(clock.read)

    runCommand(ledger, clock, { id: "1", name: "prompt", arrivedAt: 0, sentAt: 2, settledAt: 12, ok: true })
    runCommand(ledger, clock, { id: "2", name: "prompt", arrivedAt: 20, sentAt: 24, settledAt: 44, ok: true })
    runCommand(ledger, clock, { id: "3", name: "prompt", arrivedAt: 50, sentAt: 51, settledAt: 56, ok: false })

    expect(formatCommandLatency(ledger.commandLatency)).toBe(
      [
        "prompt answered 2: round trip 15ms mean, 20ms max; main 3ms mean, 4ms max",
        "prompt failed 1: round trip 5ms mean, 5ms max; main 1ms mean, 1ms max",
      ].join("\n"),
    )
  })

  test("a partly measured main leg says so instead of dividing by the wrong count", () => {
    const clock = testClock()
    const ledger = new RecoveryLedger(clock.read)

    clock.set(0)
    ledger.noteSent("bare", "abort", {})
    clock.set(10)
    ledger.noteSettled("bare", { ok: true })
    runCommand(ledger, clock, { id: "routed", name: "abort", arrivedAt: 20, sentAt: 26, settledAt: 30, ok: true })

    // The main mean is six over one sample, not six over two. Saying which is
    // the difference between a reader trusting the number and being misled by it.
    expect(formatCommandLatency(ledger.commandLatency)).toBe(
      "abort answered 2: round trip 7ms mean, 10ms max; main 6ms mean, 6ms max over 1 of 2",
    )
  })

  test("an unmeasured main leg is reported as unmeasured rather than as zero", () => {
    const clock = testClock()
    const ledger = new RecoveryLedger(clock.read)

    clock.set(0)
    ledger.noteSent("bare", "abort", {})
    clock.set(4)
    ledger.noteSettled("bare", { ok: true })

    expect(formatCommandLatency(ledger.commandLatency)).toBe(
      "abort answered 1: round trip 4ms mean, 4ms max; main leg unmeasured",
    )
  })

  test("nothing settled yet reads as nothing settled yet", () => {
    expect(formatCommandLatency(new RecoveryLedger().commandLatency)).toBe("no commands settled yet")
  })
})
