import { describe, expect, test } from "bun:test"
import { BakePiError } from "@bake-pi/contract"
import {
  Capacity,
  HOST_BASELINE_CEILING_BYTES,
  HOST_MEMORY_CEILING_BYTES,
  MAX_OPEN_SESSIONS,
  MEASURED_SESSION_BYTES,
  SESSION_MEMORY_BUDGET_BYTES,
} from "./budget.ts"

/**
 * The admission rules, decided here rather than at the call sites.
 *
 * What this file cannot do is measure anything: the numbers the rules run on
 * come from `scripts/budgets.ts`, which needs a real Pi runtime and a real
 * process to weigh. What it can do is pin the decisions those numbers feed —
 * which limit is reported when two are breached, what a boundary value does,
 * and that nothing here is a warning.
 */

const codeOf = (act: () => void): string => {
  try {
    act()
  } catch (error) {
    return error instanceof BakePiError ? error.code : `not a BakePiError: ${String(error)}`
  }
  return "no error"
}

describe("opening a session", () => {
  test("admits up to the cap and refuses the one past it", () => {
    const capacity = new Capacity({ maxOpenSessions: 3, residentBytes: () => 0 })
    expect(() => {
      capacity.admitSession(2)
    }).not.toThrow()
    expect(codeOf(() => {
      capacity.admitSession(3)
    })).toBe("session_limit_reached")
  })

  test("a host already past the cap stays refused rather than wrapping", () => {
    // Reachable: the cap can be lowered by a build while sessions are open, and
    // a `>` where this needs `>=` would admit every session after that forever.
    const capacity = new Capacity({ maxOpenSessions: 3, residentBytes: () => 0 })
    expect(codeOf(() => {
      capacity.admitSession(9)
    })).toBe("session_limit_reached")
  })

  test("reservations count sessions still being built and release exactly once", () => {
    const capacity = new Capacity({ maxOpenSessions: 2, residentBytes: () => 0 })
    const releaseFirst = capacity.reserveSession(0)
    const releaseSecond = capacity.reserveSession(0)

    expect(codeOf(() => {
      capacity.reserveSession(0)
    })).toBe("session_limit_reached")

    releaseFirst()
    releaseFirst()
    const releaseReplacement = capacity.reserveSession(0)

    releaseSecond()
    releaseReplacement()
  })

  test("refuses a host over the memory ceiling even with slots free", () => {
    const capacity = new Capacity({
      maxOpenSessions: 32,
      memoryCeilingBytes: 100,
      residentBytes: () => 100,
    })
    expect(codeOf(() => {
      capacity.admitSession(0)
    })).toBe("memory_ceiling_reached")
  })

  test("the count is reported first when both limits are breached", () => {
    // Not a preference about error codes. A host at its session cap is told to
    // close a session, which works; a host over its ceiling is told something no
    // close will fix. Reporting the ceiling while the cap is also breached sends
    // the user to the wrong remedy — and to `restart_host` — for a state they
    // could have resolved themselves.
    const capacity = new Capacity({ maxOpenSessions: 2, memoryCeilingBytes: 100, residentBytes: () => 1_000 })
    expect(codeOf(() => {
      capacity.admitSession(2)
    })).toBe("session_limit_reached")
  })

  test("memory is not read when the count already refuses", () => {
    let reads = 0
    const capacity = new Capacity({
      maxOpenSessions: 1,
      residentBytes: () => {
        reads += 1
        return 0
      },
    })
    expect(codeOf(() => {
      capacity.admitSession(1)
    })).toBe("session_limit_reached")
    expect(reads).toBe(0)
  })

  test("neither refusal is retryable, because neither resolves on its own", () => {
    const full = new Capacity({ maxOpenSessions: 1, residentBytes: () => 0 })
    const heavy = new Capacity({ memoryCeilingBytes: 1, residentBytes: () => 2 })
    for (const act of [() => full.admitSession(1), () => heavy.admitSession(0)]) {
      try {
        act()
        throw new Error("expected a refusal")
      } catch (error) {
        expect((error as BakePiError).retryable).toBe(false)
      }
    }
  })
})

describe("queueing a prompt", () => {
  test("admits up to the cap and refuses the one past it", () => {
    const capacity = new Capacity({ maxQueuedPrompts: 2 })
    expect(() => {
      capacity.admitQueuedPrompt(1)
    }).not.toThrow()
    expect(codeOf(() => {
      capacity.admitQueuedPrompt(2)
    })).toBe("queue_cap_exceeded")
  })

  test("reservations are per session and count commands still preparing input", () => {
    const capacity = new Capacity({ maxQueuedPrompts: 2 })
    const releaseFirst = capacity.reserveQueuedPrompt("s1", 0)
    const releaseSecond = capacity.reserveQueuedPrompt("s1", 0)

    expect(codeOf(() => {
      capacity.reserveQueuedPrompt("s1", 0)
    })).toBe("queue_cap_exceeded")

    const releaseOtherSession = capacity.reserveQueuedPrompt("s2", 0)
    releaseFirst()
    releaseFirst()
    const releaseReplacement = capacity.reserveQueuedPrompt("s1", 0)

    releaseSecond()
    releaseOtherSession()
    releaseReplacement()
  })
})

describe("starting more work", () => {
  test("refuses at the resident ceiling even when the session is already open", () => {
    let resident = 99
    const capacity = new Capacity({ memoryCeilingBytes: 100, residentBytes: () => resident })
    expect(() => capacity.admitWork()).not.toThrow()

    resident = 100
    expect(codeOf(() => capacity.admitWork())).toBe("memory_ceiling_reached")
  })
})

describe("the declared numbers are consistent with each other", () => {
  // `scripts/budgets.ts` measures; this checks the arithmetic between the
  // measurements, which does not need a process to weigh and so belongs in the
  // suite that runs on every commit.
  test("the session cap fits inside the session budget at the measured cost", () => {
    expect(MAX_OPEN_SESSIONS * MEASURED_SESSION_BYTES).toBeLessThanOrEqual(SESSION_MEMORY_BUDGET_BYTES)
  })

  test("the ceiling is the baseline plus what sessions are allowed", () => {
    expect(HOST_MEMORY_CEILING_BYTES).toBe(HOST_BASELINE_CEILING_BYTES + SESSION_MEMORY_BUDGET_BYTES)
  })

  test("the ceiling leaves room above the baseline for the sessions the cap allows", () => {
    // A ceiling at or below the empty host's own cost refuses every session on a
    // machine that is behaving perfectly.
    expect(HOST_MEMORY_CEILING_BYTES - HOST_BASELINE_CEILING_BYTES).toBeGreaterThanOrEqual(
      MAX_OPEN_SESSIONS * MEASURED_SESSION_BYTES,
    )
  })
})
