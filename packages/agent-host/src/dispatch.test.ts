import { describe, expect, test } from "bun:test"
import { BakePiError, type EventEnvelope, type ResponseEnvelope } from "@bake-pi/contract"
import { Diagnostics } from "./diagnostics.ts"
import { createDispatcher, type Dispatch } from "./dispatch.ts"
import { EventEmitter } from "./emitter.ts"
import type { HostMessagePort } from "./parent-port.ts"
import { TimingStore, type OpenSpanCount, type Span } from "./observability/timings.ts"
import type { HostServices } from "./services.ts"

/**
 * What the host's own leg of a command costs, and which parts of it are in the
 * figure.
 *
 * The claim under test is arithmetic rather than architectural, so the tests
 * are arithmetic. Three stretches of a command's life are given three distinct,
 * unmistakable costs -- validation 7, the handler 10, posting the response 100
 * -- and the assertion is the sum. A span that started after `acceptCommand`
 * reads 110; one that closed before the response was posted reads 17; one that
 * covers only the handler, which is what the instrument this replaces measured,
 * reads 10. Only the whole leg reads 117, and no ceiling or "greater than zero"
 * assertion can tell those four apart.
 *
 * Charging validation to the span is measurable at all because of one detail
 * worth naming: `acceptCommand`'s size guard runs `JSON.stringify` over the
 * envelope before anything else, so a `toJSON` on a nested value is a hook that
 * fires *inside* the validation step. That is also the case the whole change is
 * for -- an eight-megabyte or malformed payload is refused by exactly that
 * stretch and by no handler at all.
 */

class FakeClock {
  #now = 0
  reads = 0
  probes = 0

  readonly clock = (): number => {
    this.reads += 1
    return this.#now
  }

  advance(ms: number): void {
    this.#now += ms
  }

  /**
   * A value that costs `ms` to serialise, for putting inside a command's params.
   *
   * `probes` counts how many times it was serialised, so a total that happens
   * to be right cannot be right for the wrong reason -- two stringifications of
   * a cheaper probe would sum the same way and mean something else.
   */
  probe(ms: number): { toJSON: () => string } {
    return {
      toJSON: () => {
        this.probes += 1
        this.advance(ms)
        return "probe"
      },
    }
  }
}

const REQUEST_ID = "11111111-1111-4111-8111-111111111111"

const command = (name: string, params: unknown = {}): unknown => ({
  kind: "command",
  id: REQUEST_ID,
  name,
  params,
})

interface Host {
  dispatch: Dispatch
  clock: FakeClock
  timings: TimingStore
  responses: ResponseEnvelope[]
  events: EventEnvelope[]
  /** Command names whose handler actually ran, in order. */
  ran: string[]
  /** What the report said at the moment each response was posted. */
  openWhilePosting: (readonly OpenSpanCount[])[]
  recordedWhilePosting: number[]
}

const hostWith = (options: { handlerMs?: number; postMs?: number; available?: boolean } = {}): Host => {
  const clock = new FakeClock()
  const timings = new TimingStore({ clock: clock.clock })
  const responses: ResponseEnvelope[] = []
  const events: EventEnvelope[] = []
  const ran: string[] = []
  const openWhilePosting: (readonly OpenSpanCount[])[] = []
  const recordedWhilePosting: number[] = []

  const emitter = new EventEmitter()
  emitter.attach({
    postMessage: (message: unknown) => void events.push(message as EventEnvelope),
    on: () => {},
    start: () => {},
    close: () => {},
  } satisfies HostMessagePort)

  /**
   * A handler map by proxy, because `HostServices` is derived from the contract
   * and a literal would be forty-two handlers that say nothing. Every command
   * gets the same handler: it records that it ran, spends `handlerMs`, and
   * throws if the params say to.
   */
  const services = new Proxy(
    {},
    {
      get:
        (_target: object, property: string | symbol) =>
        async (params: unknown): Promise<unknown> => {
          ran.push(String(property))
          clock.advance(options.handlerMs ?? 0)
          if ((params as { fail?: unknown } | undefined)?.fail === true) {
            throw new BakePiError("session_busy", { retryable: true })
          }
          await (params as { hold?: Promise<void> } | undefined)?.hold
          return { ok: String(property) }
        },
    },
  ) as HostServices

  const dispatch = createDispatcher({
    diagnostics: new Diagnostics(),
    emitter,
    timings,
    services: () => (options.available === false ? undefined : services),
    respond: (response) => {
      // Read from inside the post, which is the only place the question "is the
      // span still open while the response is being handed over" can be asked.
      const snapshot = timings.snapshot()
      openWhilePosting.push(snapshot.open)
      recordedWhilePosting.push(snapshot.cost.spansRecorded)
      clock.advance(options.postMs ?? 0)
      responses.push(response)
    },
  })

  return { dispatch, clock, timings, responses, events, ran, openWhilePosting, recordedWhilePosting }
}

/** A handler this test resolves by hand, so two commands can be in flight at once. */
const held = (): { promise: Promise<void>; release: () => void } => {
  let release = (): void => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

const recorded = (host: Host): readonly Span[] => host.timings.snapshot().recent

const errorCode = (response: ResponseEnvelope | undefined): string | undefined =>
  response !== undefined && !response.ok ? response.error.code : undefined

describe("the host's leg of a command", () => {
  test("is measured from before validation to after the response is posted", async () => {
    const host = hostWith({ handlerMs: 10, postMs: 100 })

    await host.dispatch(command("get_timings", { probe: host.clock.probe(7) }))

    expect(host.clock.probes).toBe(1)
    expect(host.ran).toEqual(["get_timings"])
    expect(recorded(host)).toEqual([{ name: "command.get_timings", ms: 117 }])
  })

  test("has the response in the port's hands while its span is still open", async () => {
    const host = hostWith({ handlerMs: 10, postMs: 100 })

    await host.dispatch(command("get_timings"))

    // The span the report is about is open, and unrecorded, at the moment the
    // report is handed over. `get_timings` is the command that makes this
    // legible -- its own handler reads the store -- but it is true of every
    // command, and a span that closed first would be a span that ended before
    // the work it measures.
    expect(host.openWhilePosting).toEqual([[{ name: "command.get_timings", count: 1 }]])
    expect(host.recordedWhilePosting).toEqual([0])
    expect(host.timings.snapshot().open).toEqual([])
  })

  test("keeps two commands in flight apart, each under its own name and its own duration", async () => {
    const host = hostWith({ handlerMs: 10 })
    const slow = held()

    // The host answers commands concurrently — main sends `get_diagnostics`
    // while a `prompt` is still being accepted — so the key that pairs a begin
    // with an end has to be per command. A key that is not makes the second
    // command's begin displace the first's span and the first's end close the
    // second's, which reads in the report as one command that took the other's
    // time and an abandonment nobody ordered.
    const first = host.dispatch(command("get_diagnostics", { limit: 10, hold: slow.promise }))
    host.clock.advance(5)
    const second = host.dispatch(command("get_runtime_info"))
    await second
    host.clock.advance(3)
    slow.release()
    await first

    expect(recorded(host)).toEqual([
      // Began at 15, ran for 10, answered at 25.
      { name: "command.get_runtime_info", ms: 10 },
      // Began at 0 and was still open the whole time the other one ran.
      { name: "command.get_diagnostics", ms: 28 },
    ])
    expect(host.timings.snapshot().cost.spansAbandoned).toBe(0)
  })

  test("costs two clock readings and one span per command, however many arrive", async () => {
    const host = hostWith({ handlerMs: 1 })

    await host.dispatch(command("get_timings"))
    await host.dispatch(command("get_runtime_info"))
    await host.dispatch(command("get_diagnostics", { limit: 10 }))

    const cost = host.timings.snapshot().cost
    // One reading to open the span and one to close it. Anything else is an
    // instrument that costs a clock read per command it did not need, and two
    // spans for one command would be a count of instruments rather than of
    // commands -- which is what leaving the old handler-map wrapper in place
    // beside this would have produced.
    expect(cost.clockReads).toBe(6)
    expect(cost.spansRecorded).toBe(3)
    expect(cost.openSpans).toBe(0)
    expect(recorded(host).map((span) => span.name)).toEqual([
      "command.get_timings",
      "command.get_runtime_info",
      "command.get_diagnostics",
    ])
  })
})

/**
 * The refusals, which are the whole reason the span moved.
 *
 * Every test here describes a command that no handler ever saw. Under an
 * instrument that wraps the handler map each of them records nothing at all,
 * and the time they spent lands in main's round trip as an unattributed
 * residual -- which is the defect being fixed rather than a hypothetical.
 */
describe("a command no handler runs", () => {
  test("is still measured when its envelope never validated, under `unknown`", async () => {
    const host = hostWith({ handlerMs: 10, postMs: 100 })

    await host.dispatch(command("definitely_not_a_command", { probe: host.clock.probe(7) }))

    expect(errorCode(host.responses[0])).toBe("unknown_command")
    expect(host.ran).toEqual([])
    // 7 for the validation that refused it and 100 for posting the refusal. The
    // handler's 10 is absent because no handler ran, which is the point.
    expect(recorded(host)).toEqual([{ name: "unknown", ms: 107 }])
  })

  test("carries no part of the name it arrived with into the report", async () => {
    const host = hostWith()

    // `name` is an arbitrary string from outside the host, bounded only in
    // length by the envelope schema. `SEC-006` is about exactly this: a span
    // named after it would carry attacker-chosen text to the renderer through
    // the one command whose result is a list of names.
    await host.dispatch(command("C:\\Users\\someone\\.pi\\credentials.json"))

    expect(JSON.stringify(host.timings.snapshot())).not.toContain("credentials")
    expect(recorded(host).map((span) => span.name)).toEqual(["unknown"])
  })

  test("is still measured when the message is not an envelope at all", async () => {
    const host = hostWith({ postMs: 100 })

    await host.dispatch({ kind: "command", params: {} })
    await host.dispatch("not even an object")

    expect(host.responses.map((response) => errorCode(response))).toEqual(["malformed_command", "malformed_command"])
    expect(recorded(host)).toEqual([
      { name: "unknown", ms: 100 },
      { name: "unknown", ms: 100 },
    ])
  })

  test("is still measured when the payload is too large to accept", async () => {
    const host = hostWith({ postMs: 100 })

    // Refused by the size guard, which is the first thing `acceptCommand` does
    // and the most expensive part of validating a payload this shape. It is
    // inside the span; the figure below does not price it because the clock
    // here is a fake, and the 7 ms probe above is what prices that stretch.
    await host.dispatch(command("get_timings", { blob: "x".repeat(9 * 1024 * 1024) }))

    expect(errorCode(host.responses[0])).toBe("payload_too_large")
    expect(recorded(host)).toEqual([{ name: "unknown", ms: 100 }])
  })

  test("is measured under its own name when main should have answered it", async () => {
    const host = hostWith({ handlerMs: 10, postMs: 100 })

    await host.dispatch(command("restart_host", { probe: host.clock.probe(7) }))

    // Named, so the span outlived validation; 107 rather than 10, so it closed
    // on the throw and after the response was posted. `restart_host` is the one
    // command main answers itself, and a host that answered it would be hiding
    // a broken router.
    expect(errorCode(host.responses[0])).toBe("internal_error")
    expect(host.ran).toEqual([])
    expect(recorded(host)).toEqual([{ name: "command.restart_host", ms: 117 - 10 }])
  })

  test("is measured under its own name when the runtime does not exist yet", async () => {
    const host = hostWith({ available: false, postMs: 100 })

    await host.dispatch(command("get_runtime_info", { probe: host.clock.probe(7) }))

    expect(errorCode(host.responses[0])).toBe("host_unavailable")
    expect(recorded(host)).toEqual([{ name: "command.get_runtime_info", ms: 107 }])
  })

  test("is measured under its own name when the host is shutting down", async () => {
    const host = hostWith({ handlerMs: 10, postMs: 100 })

    await host.dispatch(command("shutdown"))
    await host.dispatch(command("get_runtime_info"))
    // The two exceptions to the gate, because a shutdown that is going badly is
    // when someone needs to read the report and the log.
    await host.dispatch(command("get_timings"))
    await host.dispatch(command("get_diagnostics", { limit: 10 }))

    expect(host.responses.map((response) => errorCode(response))).toEqual([
      undefined,
      "host_shutting_down",
      undefined,
      undefined,
    ])
    expect(host.ran).toEqual(["shutdown", "get_timings", "get_diagnostics"])
    expect(recorded(host)).toEqual([
      { name: "command.shutdown", ms: 110 },
      // Refused before any handler: no handler cost in the figure, and it is
      // recorded rather than lost.
      { name: "command.get_runtime_info", ms: 100 },
      { name: "command.get_timings", ms: 110 },
      { name: "command.get_diagnostics", ms: 110 },
    ])
    expect(host.events.map((envelope) => envelope.name)).toEqual(["host_shutting_down"])
  })

  test("is measured when its handler throws", async () => {
    const host = hostWith({ handlerMs: 10, postMs: 100 })

    // The property the recording has to be in a `finally` for. A command that
    // fails slowly is a command worth seeing, and it is the one an instrument
    // placed after the call would miss.
    await host.dispatch(command("abort", { sessionId: "session-1", fail: true }))

    expect(errorCode(host.responses[0])).toBe("session_busy")
    expect(recorded(host)).toEqual([{ name: "command.abort", ms: 110 }])
  })
})
