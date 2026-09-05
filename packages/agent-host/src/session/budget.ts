import { BakePiError } from "@bake-pi/contract"

/**
 * The host's capacity limits, and why there are three rather than one.
 *
 * Every number here is measured by `scripts/budgets.ts` against real Pi in a
 * real process, and that script fails if the measurement moves past what is
 * declared. None of them are round numbers chosen because they looked safe;
 * where a value is rounded, it is rounded down from something observed.
 *
 * **A count, because the fixed cost of a session is knowable.** An open session
 * is not a handle. It is a Pi `AgentSessionRuntime`: a services container, an
 * extension set loaded through jiti, event subscriptions, a session file with a
 * lock and possibly a tool marker beside it, and this host's own projection of
 * all of it. That cost is roughly the same for every session, so a count divides
 * the budget cleanly and refuses *before* the memory is spent rather than after.
 *
 * **A ceiling, because the variable cost is not.** A session's history lives in
 * memory and grows for as long as the conversation does, and no session count
 * bounds it — one session with four thousand turns outweighs thirty idle ones.
 * The ceiling is what notices that, and it is deliberately a refusal to take on
 * *new* work rather than a promise to recover: nothing here evicts a session.
 * Evicting one would drop a conversation the user is watching, release a lock a
 * turn may be mid-append against, and abandon a running tool — three
 * user-visible harms to avoid one that has not happened yet.
 *
 * Which means a host that reaches the ceiling stays there. Resident memory does
 * not fall back when a session closes — allocators do not return pages eagerly,
 * and `scripts/budgets.ts` shows it — so the honest resolution is
 * `restart_host`, which main answers itself and which works when no host exists.
 * Reporting the ceiling as reached is what makes that resolution available;
 * pretending a close would fix it is what would make it look broken.
 *
 * **A queue cap, because a queue is the one unbounded thing a user can build by
 * hand.** Prompts sent while a turn is streaming go to Pi's follow-up queue,
 * which has no limit of its own. Every entry is a turn that will be spent
 * against the model when its predecessor settles.
 *
 * The fourth limit, the buffered-event byte cap, is not here: it belongs to the
 * emitter, is shared with the renderer, and so lives in the contract as
 * `MAX_QUEUED_SESSION_BYTES`.
 */

/**
 * The marginal resident cost of one more open session that has taken a turn.
 *
 * Measured at 1.7–1.9 MB and declared with headroom. Deliberately not the cost
 * of the *first* session, which also pays for everything Pi loads lazily on
 * first use and came in ten times higher. See `scripts/budgets.ts`.
 */
export const MEASURED_SESSION_BYTES = 3 * 1024 * 1024

/**
 * The marginal resident cost of one more 16 KB turn on a session already forty
 * turns deep.
 *
 * The depth is part of the claim, not a detail of how it was measured. A turn
 * does not cost a constant amount: the same 16 KB reply retained 0.37 MB over
 * the first twenty turns of a session and 1.72 MB over the next twenty, because
 * each turn carries the whole conversation before it. That is the reason a
 * session count cannot bound a host's memory and the reason there is a ceiling
 * as well as a cap.
 */
export const MEASURED_TURN_BYTES = 3 * 1024 * 1024

/** Forty 16 KB turns on one session, retained after collection. Measured at 41 MB. */
export const MEASURED_DEEP_SESSION_BYTES = 64 * 1024 * 1024

/**
 * What the runtime costs before any session exists: `ModelRuntime`, the trust
 * store, Pi's module graph. Measured at 122–123 MB.
 *
 * Declared so the script fails if it moves, and so the ceiling below is visibly
 * a budget for *sessions* rather than for the process.
 */
export const HOST_BASELINE_CEILING_BYTES = 192 * 1024 * 1024

/**
 * The resident memory open sessions may collectively account for.
 *
 * Derived rather than picked: the session cap's worth of fixed cost (32 × 3 MB)
 * plus room for four conversations as deep as the one measured above (4 × 64 MB
 * would overshoot, so this is the rounded figure that four *measured* 41 MB
 * sessions fit inside). A host doing more than that at once is not a session
 * rail; it is something that has stopped being bounded by what a person can
 * read.
 */
export const SESSION_MEMORY_BUDGET_BYTES = 256 * 1024 * 1024

/**
 * How many sessions may be open at once.
 *
 * Derived by hand from the measurement rather than computed from it, so that a
 * measurement drifting cheaper cannot silently raise the cap without anyone
 * deciding to raise it. `scripts/budgets.ts` fails if the measurement stops
 * supporting this number.
 */
export const MAX_OPEN_SESSIONS = 32

/**
 * Resident bytes above which no new session is admitted: what the host costs
 * empty, plus everything its sessions are allowed.
 *
 * A host past this is holding more history than the cap anticipated or has
 * leaked, and neither is a state to start another session in.
 */
export const HOST_MEMORY_CEILING_BYTES = HOST_BASELINE_CEILING_BYTES + SESSION_MEMORY_BUDGET_BYTES

/**
 * How many prompts may wait behind the turn in flight.
 *
 * Small on purpose. A queue is a plan the user made several minutes ago about a
 * conversation that has since moved on, and a deep one is more likely to be a
 * key held down or a loop in a script than an intention.
 */
export const MAX_QUEUED_PROMPTS = 16

export interface CapacityOptions {
  maxOpenSessions?: number
  memoryCeilingBytes?: number
  maxQueuedPrompts?: number
  /**
   * How resident memory is read. Injected so the ceiling can be tested by
   * deciding what the host weighs, rather than by trying to make a test process
   * actually weigh it.
   */
  residentBytes?: () => number
}

/**
 * The admission checks, in one object so every caller applies them in the same
 * order and none of them invents a fourth limit.
 *
 * Both methods throw or return; neither reports a warning. A limit that is only
 * logged is not enforced, and the whole point of the criterion is enforcement.
 */
export class Capacity {
  readonly #maxOpenSessions: number
  readonly #memoryCeilingBytes: number
  readonly #maxQueuedPrompts: number
  readonly #residentBytes: () => number
  #reservedSessions = 0
  readonly #reservedQueuedPrompts = new Map<string, number>()

  constructor(options: CapacityOptions = {}) {
    this.#maxOpenSessions = options.maxOpenSessions ?? MAX_OPEN_SESSIONS
    this.#memoryCeilingBytes = options.memoryCeilingBytes ?? HOST_MEMORY_CEILING_BYTES
    this.#maxQueuedPrompts = options.maxQueuedPrompts ?? MAX_QUEUED_PROMPTS
    this.#residentBytes = options.residentBytes ?? (() => process.memoryUsage.rss())
  }

  /**
   * Decides whether one more session may be opened, given how many already are.
   *
   * Count before memory, because the count is the limit the user can act on: a
   * host at its session cap tells them to close one, and a host past its ceiling
   * tells them something they cannot fix by closing anything. Reporting the
   * second when the first is true would send them to the wrong remedy.
   */
  admitSession(openSessions: number): void {
    if (openSessions >= this.#maxOpenSessions) {
      throw new BakePiError("session_limit_reached", {
        detail: `${String(openSessions)} of ${String(this.#maxOpenSessions)} sessions open`,
      })
    }
    this.admitWork()
  }

  /**
   * Refuses new work once existing histories have spent the resident budget.
   *
   * A session count cannot see one conversation growing deep. Prompt delivery
   * uses this check as well as session creation so the ceiling bounds future
   * growth rather than becoming visible only when somebody opens another tab.
   */
  admitWork(): void {
    const resident = this.#residentBytes()
    if (resident < this.#memoryCeilingBytes) return
    throw new BakePiError("memory_ceiling_reached", { detail: `${String(Math.round(resident / 1_048_576))} MB` })
  }

  /**
   * Claims capacity while a session is being built but is not open yet.
   *
   * Session construction crosses several awaits. Without a reservation, every
   * concurrent command can observe the same `sessions.size` and all pass the
   * cap before any one of them enters the map. The returned release is
   * idempotent so the caller can transfer the claim to the map at registration
   * and still release it unconditionally on every failure path.
   */
  reserveSession(openSessions: number): () => void {
    this.admitSession(openSessions + this.#reservedSessions)
    this.#reservedSessions += 1

    let released = false
    return () => {
      if (released) return
      released = true
      this.#reservedSessions -= 1
    }
  }

  /** Decides whether one more prompt may wait, given how many already do. */
  admitQueuedPrompt(queued: number): void {
    if (queued < this.#maxQueuedPrompts) return
    throw new BakePiError("queue_cap_exceeded", {
      detail: `${String(queued)} of ${String(this.#maxQueuedPrompts)} queued`,
    })
  }

  /**
   * Claims one queue position across asynchronous attachment and input work.
   *
   * Reservations are per session: a full conversation must not refuse an
   * unrelated session. The release is idempotent so the caller can transfer
   * the claim to Pi's queue and still run it unconditionally on failure.
   */
  reserveQueuedPrompt(sessionId: string, queued: number): () => void {
    const reserved = this.#reservedQueuedPrompts.get(sessionId) ?? 0
    this.admitQueuedPrompt(queued + reserved)
    this.#reservedQueuedPrompts.set(sessionId, reserved + 1)

    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (this.#reservedQueuedPrompts.get(sessionId) ?? 1) - 1
      if (remaining === 0) this.#reservedQueuedPrompts.delete(sessionId)
      else this.#reservedQueuedPrompts.set(sessionId, remaining)
    }
  }
}
