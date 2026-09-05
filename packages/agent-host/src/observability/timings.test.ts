import { describe, expect, test } from "bun:test"
import { COMMAND_NAMES } from "@bake-pi/contract"
import { MAX_OPEN_SESSIONS } from "../session/budget.ts"
import {
  type Clock,
  DEFAULT_MAX_TRACKED_SESSIONS,
  DEFAULT_RING_CAPACITY,
  MAX_SESSION_ID_LENGTH,
  type SessionTimings,
  type SpanAggregate,
  type SpanName,
  TOOL_LABELS,
  TimingStore,
  type ToolLabel,
  toolLabel,
} from "./timings.ts"

/**
 * What the timing store promises, and what would falsify each promise.
 *
 * Four of these are not really tests of behaviour but tests of a constraint the
 * milestone put on the instrument: that it never allocates per block delta, that
 * its footprint does not grow with what it records, that a span cannot carry a
 * string from host internals, and that it reads the clock exactly where it
 * claims to. Those are asserted as exact numbers -- clock reads, byte counts,
 * key lists -- because an approximate assertion on any of them would pass for an
 * instrument that had quietly started costing more than the thing it measures.
 */

/**
 * A clock that only moves when a test says so, and that counts its own reads.
 *
 * The read count is the whole reason this is a class rather than a closure over
 * a number: several tests below assert an exact number of clock reads, and the
 * store's own `cost.clockReads` is cross-checked against this one so neither
 * counter can drift into agreeing with itself.
 */
class FakeClock {
  now = 0
  reads = 0

  readonly clock: Clock = () => {
    this.reads += 1
    return this.now
  }

  advance(ms: number): void {
    this.now += ms
  }
}

/** Opens a tool span, advances the clock by exactly `ms`, and closes it. */
const timeTool = (store: TimingStore, clock: FakeClock, key: string, label: ToolLabel, ms: number): void => {
  store.beginTool(key, label)
  clock.advance(ms)
  store.endTool(key)
}

const aggregateNamed = (store: TimingStore, name: string): SpanAggregate => {
  const found = store.snapshot().aggregates.find((entry) => entry.name === name)
  if (found === undefined) throw new Error(`no aggregate named ${name}`)
  return found
}

const sessionIn = (store: TimingStore, sessionId: string): SessionTimings => {
  const found = store.snapshot().sessions.find((entry) => entry.sessionId === sessionId)
  if (found === undefined) throw new Error(`no session named ${sessionId}`)
  return found
}

/** How many turns of one leg a session recorded, or zero if it never recorded that leg. */
const turnCount = (store: TimingStore, sessionId: string, name: string): number =>
  sessionIn(store, sessionId).turns.find((entry) => entry.name === name)?.count ?? 0

/** Opens a turn, advances the clock by `ms`, and settles it. */
const timeTurn = (store: TimingStore, clock: FakeClock, sessionId: string, ms: number): void => {
  store.beginTurn(sessionId)
  clock.advance(ms)
  store.endTurn(sessionId)
}

/** The bucket a single duration lands in, read back through the p50 of one sample. */
const bucketFor = (ms: number): { atLeastMs: number; belowMs: number | null } => {
  const clock = new FakeClock()
  const store = new TimingStore({ clock: clock.clock })
  timeTool(store, clock, "call", "read", ms)
  const p50 = aggregateNamed(store, "tool.read").p50
  if (p50 === null) throw new Error("a recorded span must have a p50")
  return p50
}

describe("the span name vocabulary", () => {
  /**
   * Pinned because the list is a hand copy of Pi 0.85.0's `ToolName` union,
   * which the package's `exports` map makes unimportable. If a Pi upgrade
   * renames a tool, nothing fails to compile; this test is the only place the
   * copy is checked against a decision anyone made.
   */
  test("is Pi's eight built-in tools plus the catch-all", () => {
    expect([...TOOL_LABELS]).toEqual(["read", "write", "edit", "bash", "powershell", "grep", "find", "ls", "other"])
  })

  test("maps each built-in tool name to itself", () => {
    for (const label of TOOL_LABELS) expect(toolLabel(label)).toBe(label)
  })

  /**
   * The security constraint, stated as behaviour. Every one of these is a string
   * a tool name could really be -- an MCP-registered tool, a path, a fragment of
   * an argument -- and every one of them has to come out as `"other"` so that no
   * span name can carry it to the renderer.
   */
  test("folds every name it does not know into a single bucket", () => {
    expect(toolLabel("mcp__github__create_pull_request")).toBe("other")
    expect(toolLabel("C:\\Users\\someone\\.pi\\credentials.json")).toBe("other")
    expect(toolLabel("Read")).toBe("other")
    expect(toolLabel("read ")).toBe("other")
    expect(toolLabel("")).toBe("other")
  })

  test("has a span name for every contract command and nothing else", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })
    for (const name of COMMAND_NAMES) {
      store.beginCommand(name)
      store.nameCommand(name, name)
      clock.advance(1)
      store.endCommand(name)
    }
    const aggregates = store.snapshot().aggregates
    const expected = [...COMMAND_NAMES].sort().map((name): SpanName => `command.${name}`)
    expect(aggregates.map((entry) => entry.name)).toEqual(expected)
    expect(aggregates.every((entry) => entry.count === 1)).toBe(true)
  })
})

describe("the ring of completed spans", () => {
  test("keeps the most recent capacity spans, oldest first", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock, capacity: 4 })
    for (const ms of [90, 20, 30, 40, 50, 60]) timeTool(store, clock, "call", "read", ms)

    expect(store.snapshot().recent).toEqual([
      { name: "tool.read", ms: 30 },
      { name: "tool.read", ms: 40 },
      { name: "tool.read", ms: 50 },
      { name: "tool.read", ms: 60 },
    ])
  })

  /**
   * The evicted spans are the ones that matter here: 90 ms was the first
   * recorded and is gone from the ring, so an aggregate that recomputed itself
   * from the ring would report a max of 60 and a count of 4.
   */
  test("leaves the aggregates intact when it evicts", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock, capacity: 4 })
    for (const ms of [90, 20, 30, 40, 50, 60]) timeTool(store, clock, "call", "read", ms)

    const aggregate = aggregateNamed(store, "tool.read")
    expect(aggregate.count).toBe(6)
    expect(aggregate.totalMs).toBe(290)
    expect(aggregate.maxMs).toBe(90)
    expect(aggregate.meanMs).toBe(48.333)
    expect(store.snapshot().recent.length).toBe(4)
  })

  /**
   * A clock that goes backwards cannot happen if every assumption in the module
   * holds -- one monotonic clock, one process, start before end. Clamping the
   * result to zero would hide the day one of those stops holding behind a
   * plausibly fast span, so the negative figure is recorded and reaches the max
   * as the only sample there is.
   */
  test("records a negative duration rather than clamping it into a plausible one", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })
    timeTool(store, clock, "call", "read", -5)

    expect(store.snapshot().recent).toEqual([{ name: "tool.read", ms: -5 }])
    expect(aggregateNamed(store, "tool.read").maxMs).toBe(-5)
    expect(aggregateNamed(store, "tool.read").meanMs).toBe(-5)
  })

  test("reads back in order before it has wrapped", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock, capacity: 4 })
    for (const ms of [7, 8]) timeTool(store, clock, "call", "bash", ms)

    expect(store.snapshot().recent).toEqual([
      { name: "tool.bash", ms: 7 },
      { name: "tool.bash", ms: 8 },
    ])
  })
})

describe("bucketed percentiles", () => {
  /**
   * The ladder is two boundaries per octave, so a duration exactly on a boundary
   * belongs to the bucket above it and one microsecond below belongs to the
   * bucket beneath. Turning the `>=` in `bucketOf` into `>` moves every one of
   * these by a bucket.
   */
  test("put a duration on a boundary in the bucket the boundary opens", () => {
    expect(bucketFor(1.5)).toEqual({ atLeastMs: 1.5, belowMs: 2 })
    expect(bucketFor(1.499)).toEqual({ atLeastMs: 1, belowMs: 1.5 })
    expect(bucketFor(2)).toEqual({ atLeastMs: 2, belowMs: 3 })
  })

  test("name the ladder's ends without inventing an edge", () => {
    expect(bucketFor(0.4)).toEqual({ atLeastMs: 0, belowMs: 0.5 })
    expect(bucketFor(0.5)).toEqual({ atLeastMs: 0.5, belowMs: 0.75 })
    expect(bucketFor(65536)).toEqual({ atLeastMs: 65536, belowMs: null })
    expect(bucketFor(1_000_000)).toEqual({ atLeastMs: 65536, belowMs: null })
  })

  test("cover the millisecond-to-multi-second range they were chosen for", () => {
    expect(bucketFor(250)).toEqual({ atLeastMs: 192, belowMs: 256 })
    expect(bucketFor(1000)).toEqual({ atLeastMs: 768, belowMs: 1024 })
    expect(bucketFor(5000)).toEqual({ atLeastMs: 4096, belowMs: 6144 })
  })

  /**
   * Ninety-five fast calls and five slow ones. The p95 has to land on the fast
   * bucket and the p99 on the slow one; a rank computed with `floor` instead of
   * `ceil`, or an inclusive cumulative comparison turned exclusive, moves one of
   * the two.
   */
  test("separate a tail from the body it hides behind", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })
    for (let call = 0; call < 95; call += 1) timeTool(store, clock, `fast-${String(call)}`, "grep", 1)
    for (let call = 0; call < 5; call += 1) timeTool(store, clock, `slow-${String(call)}`, "grep", 5000)

    const aggregate = aggregateNamed(store, "tool.grep")
    expect(aggregate.count).toBe(100)
    expect(aggregate.p50).toEqual({ atLeastMs: 1, belowMs: 1.5 })
    expect(aggregate.p95).toEqual({ atLeastMs: 1, belowMs: 1.5 })
    expect(aggregate.p99).toEqual({ atLeastMs: 4096, belowMs: 6144 })
    expect(aggregate.maxMs).toBe(5000)
  })

  /**
   * Three samples in three buckets. The median is the middle one, which is rank
   * two: a rank computed by flooring `0.5 * 3` would answer with the fastest.
   */
  test("round a fractional rank up, so the median of three is the middle one", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })
    for (const [call, ms] of [1, 100, 5000].entries()) timeTool(store, clock, `call-${String(call)}`, "find", ms)

    expect(aggregateNamed(store, "tool.find").p50).toEqual({ atLeastMs: 96, belowMs: 128 })
  })

  test("report the one sample they have as the p50 of one sample", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })
    timeTool(store, clock, "only", "ls", 300)

    const aggregate = aggregateNamed(store, "tool.ls")
    expect(aggregate.p50).toEqual({ atLeastMs: 256, belowMs: 384 })
    expect(aggregate.p99).toEqual({ atLeastMs: 256, belowMs: 384 })
  })
})

describe("a turn", () => {
  test("decomposes into two legs and a total that they sum to", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })

    const turn = store.beginTurn("session-1")
    clock.advance(400)
    turn.noteFirstDelta()
    clock.advance(1600)
    store.endTurn("session-1")

    expect(store.snapshot().recent).toEqual([
      { name: "turn.accepted_to_first_delta", ms: 400, sessionId: "session-1" },
      { name: "turn.first_delta_to_settled", ms: 1600, sessionId: "session-1" },
      { name: "turn.accepted_to_settled", ms: 2000, sessionId: "session-1" },
    ])
  })

  /**
   * The per-delta budget, asserted as an exact count rather than as a duration.
   * A thousand deltas cost one clock read between them, which is the first one;
   * dropping the `firstDeltaAt` guard in `noteFirstDelta` makes this 1002.
   */
  test("stamps only its first delta, however many deltas follow", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })

    const turn = store.beginTurn("session-1")
    clock.advance(120)
    for (let delta = 0; delta < 1000; delta += 1) {
      turn.noteFirstDelta()
      clock.advance(1)
    }
    store.endTurn("session-1")

    expect(clock.reads).toBe(3)
    expect(store.snapshot().cost.clockReads).toBe(3)
    expect(store.snapshot().recent).toEqual([
      { name: "turn.accepted_to_first_delta", ms: 120, sessionId: "session-1" },
      { name: "turn.first_delta_to_settled", ms: 1000, sessionId: "session-1" },
      { name: "turn.accepted_to_settled", ms: 1120, sessionId: "session-1" },
    ])
  })

  /**
   * A turn that never streams is a real turn -- an immediate refusal, a turn
   * that is all tool call -- and recording a zero-millisecond first-delta leg
   * for it would drag the aggregate for that leg toward zero with turns that
   * never had one.
   */
  test("records only its total when no delta ever arrived", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })

    store.beginTurn("session-1")
    clock.advance(75)
    store.endTurn("session-1")

    expect(store.snapshot().recent).toEqual([
      { name: "turn.accepted_to_settled", ms: 75, sessionId: "session-1" },
    ])
    expect(store.snapshot().aggregates.map((entry) => entry.name)).toEqual(["turn.accepted_to_settled"])
  })

  test("measures from the newest prompt when a second one displaces the first", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })

    store.beginTurn("session-1")
    clock.advance(1000)
    store.beginTurn("session-1")
    clock.advance(30)
    store.endTurn("session-1")

    expect(store.snapshot().recent).toEqual([
      { name: "turn.accepted_to_settled", ms: 30, sessionId: "session-1" },
    ])
    expect(aggregateNamed(store, "turn.accepted_to_settled").abandoned).toBe(1)
    // The displaced turn is the session's own loss, so it is counted there too:
    // one turn measured and one that never was.
    expect(sessionIn(store, "session-1").turns).toEqual([
      expect.objectContaining({ name: "turn.accepted_to_settled", count: 1, abandoned: 1 }),
    ])
  })

  test("ignores a delta noted on a handle whose turn has already settled", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })

    const turn = store.beginTurn("session-1")
    clock.advance(50)
    store.endTurn("session-1")
    const readsAfterSettle = clock.reads
    turn.noteFirstDelta()

    expect(clock.reads).toBe(readsAfterSettle)
    expect(store.snapshot().recent).toEqual([
      { name: "turn.accepted_to_settled", ms: 50, sessionId: "session-1" },
    ])
  })
})

/**
 * The dimension the milestone's exit criterion is actually about.
 *
 * `scripts/budgets.ts` measured a turn getting roughly three times more
 * expensive over forty turns of history, and the host admits up to
 * `MAX_OPEN_SESSIONS` sessions at once. So a host-wide turn mean is an average
 * over populations that are known to differ, and "turns are slow" is not an
 * attribution. Every test here is written so that a store which computed one
 * host-wide figure and copied it into each session would fail: the sessions are
 * given deliberately different numbers of turns and deliberately different
 * durations.
 */
describe("a turn's session dimension", () => {
  test("files a settled turn's three legs against the session that ran it", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })

    const turn = store.beginTurn("session-a")
    clock.advance(400)
    turn.noteFirstDelta()
    clock.advance(600)
    store.endTurn("session-a")

    expect(sessionIn(store, "session-a").turns.map((entry) => [entry.name, entry.count, entry.totalMs])).toEqual([
      ["turn.accepted_to_first_delta", 1, 400],
      ["turn.accepted_to_settled", 1, 1000],
      ["turn.first_delta_to_settled", 1, 600],
    ])
  })

  /**
   * The whole point, stated as arithmetic. Session `deep` takes two fast turns
   * and session `heavy` takes one slow one; the host-wide mean is 466.667 ms,
   * which describes neither session and would have anyone looking in the wrong
   * place. Copying the host-wide figure into both sessions -- the failure a fake
   * session dimension would have -- breaks all six of these numbers.
   */
  test("keeps two sessions' figures apart, which is what a host-wide mean hides", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })

    timeTurn(store, clock, "deep", 100)
    timeTurn(store, clock, "heavy", 1000)
    timeTurn(store, clock, "deep", 300)

    const deep = sessionIn(store, "deep").turns[0]
    expect(deep).toEqual(expect.objectContaining({ name: "turn.accepted_to_settled", count: 2, totalMs: 400, maxMs: 300, meanMs: 200 }))

    const heavy = sessionIn(store, "heavy").turns[0]
    expect(heavy).toEqual(expect.objectContaining({ name: "turn.accepted_to_settled", count: 1, totalMs: 1000, maxMs: 1000, meanMs: 1000 }))

    const hostWide = aggregateNamed(store, "turn.accepted_to_settled")
    expect(hostWide.count).toBe(3)
    expect(hostWide.meanMs).toBe(466.667)
  })

  /** Each turn leg in `recent` names its own session, so an interleaved ring is still decomposable. */
  test("tags each turn leg in the ring with the session it belongs to", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })

    store.beginTurn("left")
    store.beginTurn("right")
    clock.advance(10)
    store.endTurn("left")
    clock.advance(5)
    store.endTurn("right")

    expect(store.snapshot().recent).toEqual([
      { name: "turn.accepted_to_settled", ms: 10, sessionId: "left" },
      { name: "turn.accepted_to_settled", ms: 15, sessionId: "right" },
    ])
  })

  /**
   * The line the design draws, held as behaviour. A tool call's duration does
   * not depend on which session ran it -- `bash` takes as long as the command
   * takes -- so splitting tools per session would make thirty-two noisy
   * populations out of one honest one. The contract refuses a tool aggregate
   * under a session; this refuses to produce one.
   */
  test("leaves tool and command spans host-wide, so a session carries turn legs only", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })

    store.beginTurn("session-a")
    timeTool(store, clock, "call-1", "bash", 500)
    store.beginCommand("req-1")
    store.nameCommand("req-1", "prompt")
    clock.advance(1)
    store.endCommand("req-1")
    store.endTurn("session-a")

    expect(sessionIn(store, "session-a").turns.map((entry) => entry.name)).toEqual(["turn.accepted_to_settled"])
    expect(aggregateNamed(store, "tool.bash").count).toBe(1)
    expect(aggregateNamed(store, "command.prompt").count).toBe(1)
  })

  test("lists a session as soon as a turn is accepted for it, with nothing measured yet", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })

    store.beginTurn("session-a")

    expect(store.snapshot().sessions).toEqual([{ sessionId: "session-a", turns: [] }])
    expect(store.snapshot().cost.trackedSessions).toBe(1)
  })

  /**
   * A session id over the contract's `SessionId` bound is not attributed and not
   * truncated. Truncating would name a session that does not exist; reporting it
   * whole would produce a payload the renderer's own schema check drops on
   * arrival, in its entirety and without a trace. The turn is still recorded,
   * because it still happened.
   */
  test("declines to attribute an id longer than the contract allows, and records the turn anyway", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })
    const tooLong = "s".repeat(MAX_SESSION_ID_LENGTH + 1)

    timeTurn(store, clock, tooLong, 50)

    expect(store.snapshot().sessions).toEqual([])
    expect(store.snapshot().recent).toEqual([{ name: "turn.accepted_to_settled", ms: 50 }])
    expect(aggregateNamed(store, "turn.accepted_to_settled").count).toBe(1)
  })

  test("attributes an id exactly at the bound", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })
    const atTheBound = "s".repeat(MAX_SESSION_ID_LENGTH)

    timeTurn(store, clock, atTheBound, 50)

    expect(store.snapshot().sessions.map((entry) => entry.sessionId)).toEqual([atTheBound])
  })

  test("records turns host-wide and attributes none when the table is configured empty", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock, maxTrackedSessions: 0 })

    timeTurn(store, clock, "session-a", 50)

    expect(store.snapshot().sessions).toEqual([])
    expect(store.snapshot().recent).toEqual([{ name: "turn.accepted_to_settled", ms: 50 }])
    expect(store.snapshot().cost.trackedSessions).toBe(0)
  })

  /**
   * What the dimension costs, as a number rather than a claim. One session that
   * streamed one turn holds three bucket arrays of its own beside the three
   * host-wide ones -- 6 * 144 bytes -- and a second turn on the same session
   * adds none.
   */
  test("costs one bucket array per leg per session, and no more for a second turn", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })

    const first = store.beginTurn("session-a")
    clock.advance(10)
    first.noteFirstDelta()
    clock.advance(10)
    store.endTurn("session-a")
    expect(store.snapshot().cost.bucketBytes).toBe(864)

    const second = store.beginTurn("session-a")
    clock.advance(10)
    second.noteFirstDelta()
    clock.advance(10)
    store.endTurn("session-a")
    expect(store.snapshot().cost.bucketBytes).toBe(864)
  })
})

/**
 * Why the session table has a bound at all, and what the bound does when it is
 * reached.
 *
 * At most `MAX_OPEN_SESSIONS` sessions exist at once, but session ids are
 * unbounded over time: a host left running all day opens and closes hundreds,
 * and a table keyed on the id would accumulate an aggregate for every one of
 * them forever. That is the same unbounded growth the ring exists to prevent,
 * arriving through a different door.
 */
describe("the bound on how many sessions are remembered", () => {
  test("is twice what the host will admit at once, so open sessions never evict each other", () => {
    // Written as the relation rather than as the number, because the number is a
    // consequence: if `MAX_OPEN_SESSIONS` moves, this cap has to move with it or
    // the sessions a person is watching start evicting one another.
    expect(DEFAULT_MAX_TRACKED_SESSIONS).toBe(2 * MAX_OPEN_SESSIONS)
  })

  test("forgets the least recently active session when a new one arrives at a full table", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock, maxTrackedSessions: 2 })

    timeTurn(store, clock, "a", 10)
    timeTurn(store, clock, "b", 10)
    // `a` takes another turn, which makes `b` the older of the two.
    timeTurn(store, clock, "a", 10)
    timeTurn(store, clock, "c", 10)

    expect(store.snapshot().sessions.map((entry) => entry.sessionId)).toEqual(["a", "c"])
    expect(store.snapshot().cost.sessionsForgotten).toBe(1)
    expect(store.snapshot().cost.trackedSessions).toBe(2)
  })

  /**
   * The refinement over plain LRU, and the reason it is worth the scan. A closed
   * session's figures can never change again; a live session's still can, even
   * if it has been idle for ten minutes. Evicting by age alone would throw away
   * the session someone is about to prompt again in order to keep one that has
   * already ended.
   */
  test("forgets a closed session before a live one, however recently the closed one ran", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock, maxTrackedSessions: 2 })

    timeTurn(store, clock, "live", 10)
    timeTurn(store, clock, "ended", 10)
    store.closeSession("ended")
    timeTurn(store, clock, "new", 10)

    expect(store.snapshot().sessions.map((entry) => entry.sessionId)).toEqual(["live", "new"])
  })

  /**
   * The failure this design had to avoid, asserted directly. The forgotten
   * session's table index goes back on the free list and is handed to the next
   * session, so every ring slot still carrying it would read back as that
   * session's turn -- one session inheriting another's history in `recent`. The
   * sweep drops the attribution and keeps the duration, which is exactly true:
   * the turn happened, and the store no longer knows whose it was.
   */
  test("drops the attribution on a forgotten session's spans rather than handing it to the next session", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock, maxTrackedSessions: 1 })

    timeTurn(store, clock, "first", 10)
    timeTurn(store, clock, "second", 20)

    expect(store.snapshot().recent).toEqual([
      { name: "turn.accepted_to_settled", ms: 10 },
      { name: "turn.accepted_to_settled", ms: 20, sessionId: "second" },
    ])
    expect(store.snapshot().cost.sessionsForgotten).toBe(1)
  })

  test("holds no more than its cap however many sessions pass through it", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock, maxTrackedSessions: 4 })

    for (let session = 0; session < 50; session += 1) timeTurn(store, clock, `s-${String(session)}`, 10)

    const cost = store.snapshot().cost
    expect(cost.trackedSessions).toBe(4)
    expect(cost.sessionsForgotten).toBe(46)
    // Four sessions, one leg each, plus the one host-wide aggregate.
    expect(cost.bucketBytes).toBe(5 * 144)
    // Nothing was lost from the host-wide figures, which is the half of the
    // report that never forgets.
    expect(aggregateNamed(store, "turn.accepted_to_settled").count).toBe(50)
  })

  test("gives a session that comes back its own history rather than a second entry", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock, maxTrackedSessions: 2 })

    timeTurn(store, clock, "other", 10)
    timeTurn(store, clock, "reopened", 10)
    store.closeSession("reopened")
    // `adoptSession` brings a session back under the id it had, so recording
    // again has to find the same entry and clear the closed mark that made it
    // the first candidate for eviction.
    timeTurn(store, clock, "reopened", 30)
    timeTurn(store, clock, "third", 10)

    expect(store.snapshot().sessions.map((entry) => entry.sessionId)).toEqual(["reopened", "third"])
    expect(turnCount(store, "reopened", "turn.accepted_to_settled")).toBe(2)
    expect(sessionIn(store, "reopened").turns[0]?.totalMs).toBe(40)
  })
})

/**
 * The defect the previous shape of this module documented and left: a session
 * closed or disposed mid-turn had a span that no `agent_settled` would ever
 * close, because the Pi subscription that would have delivered one went away
 * with the session.
 *
 * The decision these tests hold is what *not* to do. Measuring accept-to-close
 * and filing it as a turn duration would be a lie -- the turn did not take that
 * long and it did not finish at all -- so a report full of fast "turns" that are
 * really closes would be worse than no attribution. An abandonment says exactly
 * what happened and nothing more.
 */
describe("a session closed mid-turn", () => {
  test("abandons the turn instead of recording accept-to-close as a duration", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })

    store.beginTurn("session-a")
    clock.advance(5000)
    const readsBefore = clock.reads
    store.closeSession("session-a")

    // No clock read, because nothing is being measured. A `closeSession` that
    // reached for `endTurn` would take a reading here and put 5000 ms into every
    // figure the report keeps.
    expect(clock.reads).toBe(readsBefore)
    expect(store.snapshot().recent).toEqual([])
    expect(store.snapshot().cost.spansRecorded).toBe(0)
    expect(store.snapshot().cost.spansAbandoned).toBe(1)
    expect(store.snapshot().open).toEqual([])

    const hostWide = aggregateNamed(store, "turn.accepted_to_settled")
    expect(hostWide.count).toBe(0)
    expect(hostWide.abandoned).toBe(1)
    expect(hostWide.meanMs).toBe(null)
  })

  test("counts the abandonment against the session, so the report says which one was cut off", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })

    timeTurn(store, clock, "session-a", 100)
    store.beginTurn("session-a")
    clock.advance(50)
    store.closeSession("session-a")

    // The measured turn survives beside the abandoned one: a report asked for
    // right after a conversation ended is exactly when someone wants to read it.
    expect(sessionIn(store, "session-a").turns).toEqual([
      expect.objectContaining({ name: "turn.accepted_to_settled", count: 1, abandoned: 1, totalMs: 100 }),
    ])
  })

  test("records nothing if the settle arrives after the close", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })

    store.beginTurn("session-a")
    clock.advance(10)
    store.closeSession("session-a")
    clock.advance(10)
    const readsBefore = clock.reads
    store.endTurn("session-a")

    expect(clock.reads).toBe(readsBefore)
    expect(store.snapshot().cost.spansRecorded).toBe(0)
    // One abandonment, not two: the close already accounted for this turn.
    expect(store.snapshot().cost.spansAbandoned).toBe(1)
  })

  test("costs nothing and abandons nothing when no turn is in flight", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })

    timeTurn(store, clock, "session-a", 10)
    const readsBefore = clock.reads
    store.closeSession("session-a")
    store.closeSession("never-seen")

    expect(clock.reads).toBe(readsBefore)
    expect(store.snapshot().cost.spansAbandoned).toBe(0)
    // Closing a session the store never heard of does not invent an entry for it.
    expect(store.snapshot().sessions.map((entry) => entry.sessionId)).toEqual(["session-a"])
  })

  /**
   * The limitation, pinned rather than glossed. A tool span is keyed on Pi's own
   * tool call id, which this store has no way to relate back to a session, so a
   * tool running when the session closed still waits for the open-span cap. That
   * is one span per session closed mid-tool, and a test that asserted otherwise
   * would be asserting a cleanup this module cannot perform.
   */
  test("cannot close a tool span it has no way to relate to the session", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })

    store.beginTurn("session-a")
    store.beginTool("call-1", "bash")
    store.closeSession("session-a")

    expect(store.snapshot().open).toEqual([{ name: "tool.bash", count: 1 }])
  })
})

describe("a span that is never closed", () => {
  /**
   * The open map is bounded by a count, so the fourth open tool evicts the
   * first. The evicted one is counted, not recorded: its duration was never
   * observed, and a store that guessed one would report a tool call that never
   * finished as if it had.
   */
  test("is evicted oldest-first once the open map is full, and counted", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock, maxOpenSpans: 3 })

    store.beginTool("call-1", "bash")
    store.beginTool("call-2", "read")
    store.beginTool("call-3", "read")
    store.beginTool("call-4", "read")

    const snapshot = store.snapshot()
    expect(snapshot.cost.openSpans).toBe(3)
    expect(snapshot.cost.spansAbandoned).toBe(1)
    expect(snapshot.cost.spansRecorded).toBe(0)
    expect(snapshot.recent).toEqual([])
    expect(aggregateNamed(store, "tool.bash").abandoned).toBe(1)
    expect(aggregateNamed(store, "tool.bash").count).toBe(0)
  })

  /** An abandoned name has no measurement, and says so rather than saying zero. */
  test("leaves its aggregate with no mean and no percentiles", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock, maxOpenSpans: 1 })

    store.beginTool("call-1", "edit")
    store.beginTool("call-2", "edit")

    const aggregate = aggregateNamed(store, "tool.edit")
    expect(aggregate.count).toBe(0)
    expect(aggregate.meanMs).toBe(null)
    expect(aggregate.p50).toBe(null)
    expect(aggregate.p95).toBe(null)
    expect(aggregate.p99).toBe(null)
  })

  test("records nothing if its end arrives after it was evicted", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock, maxOpenSpans: 1 })

    store.beginTool("call-1", "find")
    store.beginTool("call-2", "find")
    clock.advance(500)
    const readsBefore = clock.reads
    store.endTool("call-1")

    expect(clock.reads).toBe(readsBefore)
    expect(store.snapshot().cost.spansRecorded).toBe(0)
  })

  test("is reported by name and never by key", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })

    store.beginTurn("session-secret")
    store.beginTool("call-secret", "write")
    store.beginTool("other-call", "write")

    expect(store.snapshot().open).toEqual([
      { name: "tool.write", count: 2 },
      { name: "turn.accepted_to_settled", count: 1 },
    ])
  })
})

describe("keys", () => {
  /**
   * Turn keys are session ids, tool keys are tool call ids and command keys are
   * request ids. Three id spaces, three minters, no guarantee of disjointness --
   * so the same literal key has to open three independent spans.
   */
  test("from different kinds of span never collide", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })

    store.beginTurn("same")
    store.beginTool("same", "grep")
    store.beginCommand("same")
    store.nameCommand("same", "prompt")
    clock.advance(10)
    store.endTool("same")
    clock.advance(10)
    store.endCommand("same")
    clock.advance(10)
    store.endTurn("same")

    expect(store.snapshot().recent).toEqual([
      { name: "tool.grep", ms: 10 },
      { name: "command.prompt", ms: 20 },
      { name: "turn.accepted_to_settled", ms: 30, sessionId: "same" },
    ])
  })

  test("that were never opened close without reading the clock", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })

    store.endTool("never-opened")
    store.endCommand("never-opened")
    store.endTurn("never-opened")

    expect(clock.reads).toBe(0)
    expect(store.snapshot().cost.spansRecorded).toBe(0)
  })

  test("that were already closed do not record a second span", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })

    store.beginTool("call-1", "ls")
    clock.advance(5)
    store.endTool("call-1")
    clock.advance(5)
    store.endTool("call-1")

    expect(store.snapshot().recent).toEqual([{ name: "tool.ls", ms: 5 }])
  })
})

describe("the instrument's own cost", () => {
  /**
   * Two clock reads per span and no more: one at the start, one at the end. The
   * turn path is the exception worth stating separately -- three spans out of
   * three reads -- and it is asserted in the turn suite above.
   */
  test("is exactly two clock reads per tool span", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })
    for (let call = 0; call < 500; call += 1) timeTool(store, clock, `call-${String(call)}`, "read", 1)

    expect(clock.reads).toBe(1000)
    expect(store.snapshot().cost.clockReads).toBe(1000)
  })

  test("is no clock reads at all to produce a snapshot", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })
    timeTool(store, clock, "call", "read", 1)
    const readsBefore = clock.reads
    store.snapshot()
    store.snapshot()

    expect(clock.reads).toBe(readsBefore)
  })

  /**
   * The bound that makes the ring safe to leave running for a day: its footprint
   * is decided at construction and does not move, because the slots are a
   * `Uint16` and a `Float64` rather than an object. Ten thousand spans through a
   * four-thousand-slot ring change the numbers not at all.
   */
  test("is a footprint fixed at construction, not one that grows with what it records", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })
    const empty = store.snapshot().cost

    // Twelve bytes a slot, not ten: the session column is a `Uint16` per slot on
    // top of the name index and the duration, which is what buys a `recent` list
    // that stays readable when two sessions stream at once.
    expect(empty.ringCapacity).toBe(DEFAULT_RING_CAPACITY)
    expect(empty.ringBytes).toBe(DEFAULT_RING_CAPACITY * 12)
    expect(empty.bucketBytes).toBe(0)

    for (let call = 0; call < 10_000; call += 1) timeTool(store, clock, `call-${String(call)}`, "read", 1)

    const loaded = store.snapshot().cost
    expect(loaded.ringBytes).toBe(DEFAULT_RING_CAPACITY * 12)
    // One name has been used, so one 36-bucket `Uint32Array` exists. Ten
    // thousand spans do not make a second one.
    expect(loaded.bucketBytes).toBe(144)
    expect(loaded.spansRecorded).toBe(10_000)
    expect(store.snapshot().recent.length).toBe(DEFAULT_RING_CAPACITY)
  })
})

describe("the snapshot", () => {
  test("carries a name and a duration on a span, and no third field", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })
    timeTool(store, clock, "call", "read", 12)

    const span = store.snapshot().recent[0]
    expect(span).toBeDefined()
    expect(Object.keys(span ?? {})).toEqual(["name", "ms"])
  })

  /**
   * The `SEC-006` constraint, checked against the serialised bytes rather than
   * against the shape.
   *
   * The line moved when turns gained a session dimension, and this is where it
   * is drawn. A session id is the renderer's own handle -- it supplied it or was
   * handed it, and it rides on every session event envelope already -- so it may
   * be reported. A Pi tool call id and a raw tool name are not: the renderer has
   * never seen the first and the second is influenced from outside this
   * repository in exactly the way a file path is. Nothing else the caller passes
   * may appear at all.
   */
  test("reports the session id it was given and no other key", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })

    const sessionId = "session-01J8Z"
    const toolKey = "toolcall-a1b2c3-rm-rf"
    const commandKey = "req-C:\\Users\\someone\\projects\\secret-client"
    store.beginTurn(sessionId)
    store.beginTool(toolKey, toolLabel("mcp__deploy__push"))
    store.beginCommand(commandKey)
    store.nameCommand(commandKey, "prompt")
    clock.advance(9)
    store.endTool(toolKey)
    store.endCommand(commandKey)
    store.endTurn(sessionId)

    const serialised = JSON.stringify(store.snapshot())
    expect(serialised.includes(toolKey)).toBe(false)
    expect(serialised.includes(commandKey)).toBe(false)
    expect(serialised.includes("mcp__deploy__push")).toBe(false)
    expect(serialised.includes("tool.other")).toBe(true)
    expect(serialised.includes(sessionId)).toBe(true)
  })

  /**
   * And it appears only where the schema says it may. A session id on a tool
   * span would be a claim the store cannot support -- tool calls are keyed on
   * Pi's own id and the store has no way to relate one back to a session -- so
   * the absence is checked per span rather than in aggregate.
   */
  test("puts the session id on turn legs only, never on a tool or a command span", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })

    store.beginTurn("session-1")
    timeTool(store, clock, "call-1", "bash", 5)
    store.beginCommand("req-1")
    store.nameCommand("req-1", "prompt")
    clock.advance(1)
    store.endCommand("req-1")
    store.endTurn("session-1")

    for (const span of store.snapshot().recent) {
      expect(Object.hasOwn(span, "sessionId")).toBe(span.name.startsWith("turn."))
    }
  })

  test("survives a JSON round trip unchanged", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })

    const turn = store.beginTurn("session-1")
    clock.advance(200)
    turn.noteFirstDelta()
    timeTool(store, clock, "call", "bash", 3000)
    store.beginCommand("req-1")
    store.nameCommand("req-1", "get_queue")
    clock.advance(0.25)
    store.endCommand("req-1")
    store.endTurn("session-1")
    store.beginTool("never-ends", "edit")

    const snapshot = store.snapshot()
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot)
  })

  test("is a copy, not a view of the store", () => {
    const clock = new FakeClock()
    const store = new TimingStore({ clock: clock.clock })
    timeTool(store, clock, "call-1", "read", 4)
    const before = store.snapshot()
    timeTool(store, clock, "call-2", "read", 4)

    expect(before.recent.length).toBe(1)
    expect(store.snapshot().recent.length).toBe(2)
  })
})
