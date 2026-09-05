/**
 * How long the application took to become usable, and which part took it.
 *
 * Milestone 3 budgets cold start at 2.5 seconds and the agent-host handshake at
 * one second. Neither number could previously be read: `scripts/smoke.ts` proved
 * the handshake *happened*, and nothing anywhere recorded how long anything
 * took. A single total would not help much either — a slow launch could be
 * Electron's own bootstrap, the renderer fetching its bundle over the custom
 * protocol, or the agent host resolving Pi, and those have nothing to do with
 * each other.
 *
 * So startup is recorded as marks and read as legs between them. Everything here
 * is one process's `performance.now()`, which needs no agreement with any other
 * clock, because every leg begins and ends inside main.
 */

export type Clock = () => number

/**
 * The one number that is not a `performance.now()` reading.
 *
 * `performance.timeOrigin` starts when V8 does, which is already well into an
 * Electron launch: the executable has been mapped, Chromium has initialised, and
 * the main process's Node has bootstrapped. All of that is cold start as a user
 * experiences it, and none of it is visible to a timer started from JavaScript.
 *
 * Electron exposes the process's real creation time, so the invisible part can
 * be recovered as a negative offset in the same frame as every other mark. It
 * costs one subtraction and moves the cold-start figure by a genuinely large
 * amount; leaving it out would make the budget look comfortably met by measuring
 * only the half that is cheap.
 *
 * It returns `null` where the platform cannot answer, which is why every leg
 * that depends on it is optional rather than defaulted to zero. A missing
 * measurement must not read as a fast one.
 */
export const nativeLaunchOffset = (creationTimeMs: number | null, timeOriginMs: number): number | null =>
  creationTimeMs === null ? null : creationTimeMs - timeOriginMs

/**
 * Named instants in one process, and the durations between them.
 *
 * First write wins. A mark names a thing that happens once during startup, and
 * the supervisor restarts the agent host on crash — without this rule, the
 * second launch of the day would quietly overwrite the cold-start record with a
 * figure measured from a process that had been running for an hour.
 */
export class Stopwatch {
  readonly #clock: Clock
  readonly #marks = new Map<string, number>()

  constructor(clock: Clock = () => performance.now()) {
    this.#clock = clock
  }

  /** Records the current instant under `name`, unless it is already recorded. */
  mark(name: string): void {
    if (this.#marks.has(name)) return
    this.#marks.set(name, this.#clock())
  }

  /** Records an instant computed elsewhere — see `nativeLaunchOffset`. */
  markAt(name: string, at: number | null): void {
    if (at === null || this.#marks.has(name)) return
    this.#marks.set(name, at)
  }

  at(name: string): number | undefined {
    return this.#marks.get(name)
  }

  /**
   * Milliseconds from one mark to another, or `undefined` if either is missing.
   *
   * Undefined rather than zero, and rather than throwing. A leg whose endpoints
   * were never both reached is unknown, and a report that prints `0.0 ms` for a
   * window that never loaded would be worse than one that prints nothing.
   */
  leg(from: string, to: string): number | undefined {
    const start = this.#marks.get(from)
    const end = this.#marks.get(to)
    if (start === undefined || end === undefined) return undefined
    return end - start
  }
}

/**
 * What the smoke report carries. Every field is milliseconds, and every one may
 * be absent, because a startup that failed halfway is exactly when these numbers
 * are worth reading.
 */
export interface StartupTimings {
  /** Process creation to the first JavaScript instant: Electron's own bootstrap. */
  nativeLaunch?: number
  /** Entry module evaluation to `app.whenReady()`. */
  toReady?: number
  /** `whenReady` to a window whose document has loaded. */
  toWindowLoaded?: number
  /** Fork of the agent host to its `hello_ack`. */
  toHostReady?: number
  /** Process creation to transferring the ready host's event port to the loaded window. */
  toConnected?: number
  /** Process creation to the renderer proving its connected interface is usable. */
  toUsable?: number
  /**
   * Process creation to a loaded window.
   *
   * This is the cold-start budget's subject, and the definition is deliberately
   * narrow: the window has its document, not its first paint and not a usable
   * interface. Milestone 3 has no interface yet, so a "time to interactive"
   * measured now would be measuring the placeholder. Narrow and stated beats
   * broad and wrong, and this leg only grows as the renderer does.
   */
  coldStart?: number
  /**
   * Fork to the host's own timeline starting: Electron spawning a process and
   * Node bootstrapping inside it, before a line of our code runs there.
   */
  hostLaunch?: number
  /** The host's entry module evaluating, which is its bundle plus Pi's imports. */
  hostModule?: number
  /** Building the Pi runtime, the one leg that depends on a third party. */
  hostRuntime?: number
}

/**
 * What the host reported about its own startup, if it reported anything.
 *
 * Structural rather than imported from the contract, because this module is the
 * one piece of main that has no reason to know what a `HelloAck` is.
 */
export interface HostStartupReport {
  moduleMs: number
  runtimeMs: number
  ackMs: number
}

const millis = (value: number | undefined): number | undefined =>
  value === undefined ? undefined : Math.round(value * 1000) / 1000

export const readStartupTimings = (watch: Stopwatch, host?: HostStartupReport): StartupTimings => {
  const timings: StartupTimings = {}
  const put = (key: keyof StartupTimings, value: number | undefined): void => {
    const rounded = millis(value)
    if (rounded !== undefined) timings[key] = rounded
  }
  put("nativeLaunch", watch.leg("processCreated", "scriptStarted"))
  put("toReady", watch.leg("scriptStarted", "appReady"))
  put("toWindowLoaded", watch.leg("appReady", "windowLoaded"))
  put("toHostReady", watch.leg("hostForked", "hostAcked"))
  put("toConnected", watch.leg("processCreated", "hostAttached"))
  put("toUsable", watch.leg("processCreated", "rendererReady"))
  put("coldStart", watch.leg("processCreated", "windowLoaded"))

  if (host !== undefined) {
    put("hostModule", host.moduleMs)
    put("hostRuntime", host.runtimeMs)
    // Two durations subtracted, not two clocks: main timed the whole fork, the
    // host timed its own share of it, and what is left is the part neither
    // process's code was running for. Deliberately not clamped at zero — the
    // host's timeline cannot start before the fork that created it, so a
    // negative figure means an assumption here is wrong and should be visible
    // rather than rounded away into a plausible small number.
    const forkToAck = watch.leg("hostForked", "hostAcked")
    if (forkToAck !== undefined) put("hostLaunch", forkToAck - host.ackMs)
  }
  return timings
}
