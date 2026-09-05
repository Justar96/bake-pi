/**
 * The restart budget, and the reason it is a budget rather than a retry.
 *
 * Reopening exactly the sessions that were open at crash time lets one session
 * that deterministically crashes the adapter burn the whole budget, with no
 * route left to open a different one. So a crash attributable to a session
 * quarantines that session and reopens the workspace without it.
 */
export interface RestartPolicy {
  maxRestarts: number
  windowMs: number
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = { maxRestarts: 3, windowMs: 5 * 60_000 }

export class RestartBudget {
  readonly #policy: RestartPolicy
  #failures: number[] = []

  constructor(policy: RestartPolicy = DEFAULT_RESTART_POLICY) {
    this.#policy = policy
  }

  /** Returns false once the budget is spent; the caller then surfaces the crash instead of retrying. */
  record(now = Date.now()): boolean {
    this.#failures = this.#failures.filter((at) => now - at < this.#policy.windowMs)
    this.#failures.push(now)
    return this.#failures.length <= this.#policy.maxRestarts
  }

  reset(): void {
    this.#failures = []
  }

  get recentFailures(): number {
    return this.#failures.length
  }
}

/*
 * Whether an automatic restart is safe at all used to live here, as a function
 * taking `{ toolInFlight, credentialInFlight }`. It was never called, and it
 * could not have been: main routes commands and does not read the event stream,
 * so `toolInFlight` is not a fact available to this process. Asking the question
 * needs the record of what the host was actually doing, which is
 * `RecoveryLedger` in `recovery.ts` — including what it still cannot see.
 */
